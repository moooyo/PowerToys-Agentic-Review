import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { investigationApi } from "./api";
import { RepositoryAutoReplySettingsPanel } from "./auto-reply-settings";
import { ImportWorkItemButton } from "./import-work-item";
import { Section } from "./report-sections";
import { SchedulerPanel } from "./scheduler-panel";
import { RepositoryWebhookSettingsPanel } from "./webhook-settings";

export default function RepositoriesPage() {
  const query = useQuery({
    queryKey: ["investigation-repositories"],
    queryFn: investigationApi.repositories,
  });
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h4">Repositories</Typography>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          Repositories shared with your account. Investigations are bound to their registered source
          snapshots.
        </Typography>
      </Box>
      <SchedulerPanel />
      {query.isPending && <CircularProgress size={28} />}
      {query.isError && (
        <Alert severity="error">
          {query.error.message}
          <Button onClick={() => void query.refetch()}>Retry directory</Button>
        </Alert>
      )}
      {query.data?.items.length === 0 && (
        <Alert severity="info">
          No repositories have been shared with your account. Ask the workspace administrator to
          register a repository and grant access.
        </Alert>
      )}
      {query.data?.items.map((repository) => (
        <Section key={repository.id} title={repository.fullName}>
          <Typography variant="caption" color="text.secondary">
            GitHub repository ID: {repository.githubRepositoryId}
          </Typography>
          <Stack direction="row" useFlexGap spacing={1} sx={{ mt: 2, flexWrap: "wrap" }}>
            <Button
              component={Link}
              to={`/pull-requests?repositoryId=${encodeURIComponent(repository.id)}`}
            >
              Pull requests
            </Button>
            <Button
              component={Link}
              to={`/issues?repositoryId=${encodeURIComponent(repository.id)}`}
            >
              Issues
            </Button>
            <Button
              component={Link}
              to={`/tasks?repositoryId=${encodeURIComponent(repository.id)}`}
            >
              Tasks
            </Button>
            <ImportWorkItemButton repository={repository} />
            <Button
              component={Link}
              to={`/comments?repositoryId=${encodeURIComponent(repository.id)}`}
            >
              Comments
            </Button>
            <Button
              component="a"
              href={`https://github.com/${repository.fullName}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open on GitHub
            </Button>
          </Stack>
          <RepositoryWebhookSettingsPanel repository={repository} />
          <RepositoryAutoReplySettingsPanel repository={repository} />
        </Section>
      ))}
    </Stack>
  );
}
