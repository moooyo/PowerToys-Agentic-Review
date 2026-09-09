import type {
  PublicationBinding,
  PublicationPayload,
  PublicationTarget,
} from "@agentic-review/contracts";
import { Descriptions, Typography } from "antd";
import "./index.css";

export function PublicationDocument({
  target,
  payload,
  publisherGitHubUserId,
  binding,
  payloadSha256,
}: {
  target: PublicationTarget;
  payload: PublicationPayload | null;
  publisherGitHubUserId: number | null;
  binding: PublicationBinding;
  payloadSha256: string | null;
}) {
  return (
    <>
      <Descriptions
        column={1}
        size="small"
        items={[
          {
            key: "target",
            label: "GitHub target",
            children: `github.com/${target.fullName} · ${target.kind === "pull_request" ? "Pull request" : "Issue"} #${target.number}`,
          },
          {
            key: "repository-id",
            label: "GitHub repository ID",
            children: target.githubRepositoryId,
          },
          { key: "item-id", label: "GitHub work item ID", children: target.githubWorkItemId },
          {
            key: "kind",
            label: "Publication kind",
            children:
              payload?.kind === "pull_request_review"
                ? "Pull request review"
                : payload?.kind === "issue_comment"
                  ? "Issue comment"
                  : "Unavailable",
          },
          {
            key: "commit",
            label: "PR commit",
            children:
              payload?.kind === "pull_request_review" ? (
                <code>{payload.commitId}</code>
              ) : (
                "Not applicable"
              ),
          },
          {
            key: "event",
            label: "GitHub event",
            children:
              payload?.kind === "pull_request_review"
                ? payload.event
                : payload?.kind === "issue_comment"
                  ? "Create Issue comment"
                  : "Unavailable",
          },
          {
            key: "publisher",
            label: "Publisher GitHub numeric ID",
            children: publisherGitHubUserId ?? "Unavailable",
          },
          {
            key: "decision",
            label: "Selected decision",
            children: <code>{binding.selectedDecisionId}</code>,
          },
          {
            key: "decision-version",
            label: "Selected decision version",
            children: binding.selectedDecisionVersion,
          },
          {
            key: "stream",
            label: "Decision stream version",
            children: binding.decisionContextVersion,
          },
          {
            key: "revision",
            label: "Reviewed revision",
            children: <code>{binding.revisionKey}</code>,
          },
          { key: "plan", label: "Frozen plan digest", children: <code>{binding.planDigest}</code> },
          {
            key: "results",
            label: "Reviewed result set digest",
            children: <code>{binding.resultSetDigest}</code>,
          },
          {
            key: "payload",
            label: "Exact payload digest",
            children: payloadSha256 ? <code>{payloadSha256}</code> : "Unavailable",
          },
        ]}
      />
      <Typography.Title level={5}>Complete outgoing body</Typography.Title>
      {payload ? (
        <section aria-label="Complete outgoing publication body">
          <pre className="publication-body">{payload.body}</pre>
        </section>
      ) : (
        <Typography.Paragraph type="secondary">
          No complete body is available. Resolve the preview blockers before confirming.
        </Typography.Paragraph>
      )}
    </>
  );
}
