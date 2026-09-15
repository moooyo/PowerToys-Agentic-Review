import RefreshRounded from "@mui/icons-material/RefreshRounded";
import { Alert, Box, Button, Chip, CircularProgress, Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import { DataTable } from "@/components/ui";
import { investigationApi, type WorkItem } from "./api";
import { ImportWorkItemButton } from "./import-work-item";
import { Section, SubjectPanel } from "./report-sections";
import { StandaloneActions } from "./report-workspace";
import { useInvestigationRepositoryScope } from "./repository-scope";
import { StartInvestigationButton, TaskList } from "./task-workspace";

function WorkItemDetails({ id }: { id: string }) {
  const item = useQuery({
    queryKey: ["investigation-work-item", id],
    queryFn: () => investigationApi.workItem(id),
  });
  const tasks = useQuery({
    queryKey: ["investigation-tasks", id],
    queryFn: () => investigationApi.tasks(id),
  });
  if (item.isPending) return <CircularProgress size={28} />;
  if (item.isError) return <Alert severity="error">{item.error.message}</Alert>;
  return (
    <Stack spacing={3}>
      <Box>
        <Stack
          direction="row"
          useFlexGap
          spacing={2}
          sx={{ flexWrap: "wrap", alignItems: "center" }}
        >
          <Typography variant="h4" sx={{ flex: 1 }}>
            {item.data.title}
          </Typography>
          <Chip label={item.data.state} />
        </Stack>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          #{item.data.number} · {item.data.kind === "pull_request" ? "Pull request" : "Issue"}
        </Typography>
        <Typography sx={{ whiteSpace: "pre-wrap", mt: 2 }}>{item.data.body}</Typography>
        <Box sx={{ mt: 2 }}>
          <StartInvestigationButton workItem={item.data} />
        </Box>
      </Box>
      <Section title="Investigations and linked work">
        {tasks.isError ? (
          <Alert severity="error">{tasks.error.message}</Alert>
        ) : tasks.isPending ? (
          <CircularProgress size={24} />
        ) : (
          <TaskList tasks={tasks.data.items} />
        )}
      </Section>
      <SubjectPanel subjects={[item.data.subject]} />
      <StandaloneActions workItem={item.data} />
    </Stack>
  );
}

export function WorkItemsPage({ kind }: { kind: WorkItem["kind"] }) {
  const scope = useInvestigationRepositoryScope();
  const location = useLocation();
  const selected = new URLSearchParams(location.search).get("workItemId");
  const query = useQuery({
    queryKey: ["investigation-work-items", scope.repositoryId, kind],
    queryFn: () => investigationApi.workItems(scope.repositoryId, kind),
    enabled: !selected,
  });
  if (selected) return <WorkItemDetails key={selected} id={selected} />;
  return (
    <Stack spacing={3}>
      <Stack direction="row" useFlexGap spacing={2} sx={{ flexWrap: "wrap", alignItems: "center" }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h4">
            {kind === "pull_request" ? "Pull requests" : "Issues"}
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            {kind === "pull_request"
              ? "Complete reviews, exact evidence, and explicit next steps."
              : "Structured bug investigations and feature assessments."}
          </Typography>
        </Box>
        {scope.repository && (
          <ImportWorkItemButton repository={scope.repository} initialKind={kind} />
        )}
        <Button startIcon={<RefreshRounded />} onClick={() => void query.refetch()}>
          Refresh
        </Button>
      </Stack>
      {process.env.NODE_ENV === "development" && (
        <Alert severity="info">
          Synthetic investigation reports for moooyo/PowerToys. Sample actions do not write to
          GitHub.
        </Alert>
      )}
      {query.isError && <Alert severity="error">{query.error.message}</Alert>}
      <DataTable
        rows={query.data?.items ?? []}
        loading={query.isPending}
        getRowId={(item) => item.id}
        ariaLabel={kind === "pull_request" ? "Pull requests" : "Issues"}
        emptyTitle="No registered work items"
        emptyDescription="Register a source snapshot in the repository workspace to start an investigation."
        columns={[
          {
            id: "title",
            label: kind === "pull_request" ? "Pull request" : "Issue",
            render: (item) => (
              <Box>
                <Button
                  component={Link}
                  to={`${kind === "pull_request" ? "/pull-requests" : "/issues"}?repositoryId=${encodeURIComponent(item.repositoryId)}&workItemId=${encodeURIComponent(item.id)}`}
                >
                  {item.title}
                </Button>
                <Typography variant="caption" component="div" color="text.secondary">
                  #{item.number} ·{" "}
                  {scope.query.data?.items.find((repository) => repository.id === item.repositoryId)
                    ?.fullName ?? item.repositoryId}
                </Typography>
              </Box>
            ),
          },
          {
            id: "state",
            label: "State",
            render: (item) => <Chip label={item.state} size="small" />,
          },
          {
            id: "subject",
            label: "Registered subject",
            render: (item) => (
              <Box>
                <Typography variant="body2">{item.subject.kind}</Typography>
                <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
                  {item.subject.kind === "original_pr"
                    ? item.subject.headSha.slice(0, 12)
                    : item.subject.revisionKey.slice(0, 12)}
                </Typography>
              </Box>
            ),
          },
          {
            id: "updated",
            label: "Updated",
            render: (item) => new Date(item.updatedAt).toLocaleString(),
          },
          {
            id: "action",
            label: "Investigation",
            render: (item) => <StartInvestigationButton workItem={item} />,
          },
        ]}
      />
    </Stack>
  );
}
