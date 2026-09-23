import { ManagedRepositoryNameSchema } from "@agentic-review/contracts";
import OpenInNewRounded from "@mui/icons-material/OpenInNewRounded";
import { Button } from "@mui/material";
import { Value } from "@sinclair/typebox/value";

export type GithubSourceLinkProps = {
  repositoryFullName: string;
  kind: "pull_request" | "issue";
  number: number;
};

export function GithubSourceLink({ repositoryFullName, kind, number }: GithubSourceLinkProps) {
  if (
    !Value.Check(ManagedRepositoryNameSchema, repositoryFullName) ||
    (kind !== "pull_request" && kind !== "issue") ||
    !Number.isSafeInteger(number) ||
    number < 1
  )
    return null;

  const path = kind === "pull_request" ? "pull" : "issues";
  const label = `Open ${kind === "pull_request" ? "PR" : "issue"} #${number} on GitHub`;

  return (
    <Button
      component="a"
      href={`https://github.com/${repositoryFullName}/${path}/${number}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${label} · ${repositoryFullName} (opens in a new tab)`}
      endIcon={<OpenInNewRounded aria-hidden="true" />}
    >
      {label}
    </Button>
  );
}
