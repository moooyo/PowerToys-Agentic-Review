import type {
  PublicationBinding,
  PublicationPayload,
  PublicationTarget,
} from "@agentic-review/contracts";
import { Typography } from "@mui/material";
import { DetailsGrid } from "@/components/ui";
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
    <div className="publication-document">
      <section className="publication-section" aria-label="GitHub publication target">
        <Typography variant="h6" component="h3">
          Publication target
        </Typography>
        <DetailsGrid
          columns={2}
          items={[
            {
              key: "target",
              label: "GitHub target",
              value: `github.com/${target.fullName} · ${target.kind === "pull_request" ? "Pull request" : "Issue"} #${target.number}`,
            },
            {
              key: "repository-id",
              label: "GitHub repository ID",
              value: target.githubRepositoryId,
            },
            { key: "item-id", label: "GitHub work item ID", value: target.githubWorkItemId },
            {
              key: "kind",
              label: "Publication kind",
              value:
                payload?.kind === "pull_request_review"
                  ? "Pull request review"
                  : payload?.kind === "issue_comment"
                    ? "Issue comment"
                    : "Unavailable",
            },
            {
              key: "commit",
              label: "PR commit",
              value:
                payload?.kind === "pull_request_review" ? (
                  <code>{payload.commitId}</code>
                ) : (
                  "Not applicable"
                ),
            },
            {
              key: "event",
              label: "GitHub event",
              value:
                payload?.kind === "pull_request_review"
                  ? payload.event
                  : payload?.kind === "issue_comment"
                    ? "Create Issue comment"
                    : "Unavailable",
            },
            {
              key: "publisher",
              label: "Publisher GitHub numeric ID",
              value: publisherGitHubUserId ?? "Unavailable",
            },
          ]}
        />
      </section>
      <section className="publication-section" aria-label="Complete outgoing publication body">
        <Typography variant="h6" component="h3">
          Complete outgoing body
        </Typography>
        {payload ? (
          <pre className="publication-body">{payload.body}</pre>
        ) : (
          <Typography color="text.secondary">
            No complete body is available. Resolve the preview blockers before confirming.
          </Typography>
        )}
      </section>
      <section className="publication-section" aria-label="Reviewed source and decision">
        <Typography variant="h6" component="h3">
          Reviewed source and decision
        </Typography>
        <DetailsGrid
          columns={2}
          items={[
            {
              key: "decision",
              label: "Selected decision",
              value: <code>{binding.selectedDecisionId}</code>,
            },
            {
              key: "decision-version",
              label: "Selected decision version",
              value: binding.selectedDecisionVersion,
            },
            {
              key: "stream",
              label: "Decision stream version",
              value: binding.decisionContextVersion,
            },
            {
              key: "revision",
              label: "Reviewed revision",
              value: <code>{binding.revisionKey}</code>,
            },
            { key: "plan", label: "Frozen plan digest", value: <code>{binding.planDigest}</code> },
            {
              key: "results",
              label: "Reviewed result set digest",
              value: <code>{binding.resultSetDigest}</code>,
            },
            {
              key: "payload",
              label: "Exact payload digest",
              value: payloadSha256 ? <code>{payloadSha256}</code> : "Unavailable",
            },
          ]}
        />
      </section>
    </div>
  );
}
