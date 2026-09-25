import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
import ChevronRightRounded from "@mui/icons-material/ChevronRightRounded";
import FolderRounded from "@mui/icons-material/FolderRounded";
import SearchRounded from "@mui/icons-material/SearchRounded";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  InputAdornment,
  Stack,
  Tab,
  TabScrollButton,
  type TabScrollButtonProps,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { investigationApi, type Repository } from "./api";
import { autoReplySettingsQueryKey, RepositoryAutoReplySettingsPanel } from "./auto-reply-settings";
import type { AutoReplyTemplateKey } from "./auto-reply-settings-form";
import { ImportWorkItemButton } from "./import-work-item";
import { useGuardedAction } from "./navigation-guard";
import { SchedulerPanel } from "./scheduler-panel";
import { useInvestigationSession } from "./session";
import { RepositoryWebhookSettingsPanel, webhookSettingsQueryKey } from "./webhook-settings";
import { EmptyState, PageHeading, Surface } from "./workspace-ui";
import "./repository-workspace.css";

export const repositorySettingsTabs = ["overview", "intake", "replies", "scheduling"] as const;
type SettingsTab = (typeof repositorySettingsTabs)[number];
const tabLabels: Record<SettingsTab, string> = {
  overview: "Overview",
  intake: "Intake",
  replies: "Replies",
  scheduling: "Scheduling",
};

function RepositoryTabScrollButton(props: TabScrollButtonProps) {
  return (
    <TabScrollButton
      {...props}
      aria-label={
        props.direction === "left"
          ? "Previous repository settings tabs"
          : "More repository settings tabs"
      }
    />
  );
}

export function repositorySettingsTab(value: string | null): SettingsTab {
  return repositorySettingsTabs.find((tab) => tab === value) ?? "overview";
}

export function repositoryReplyTemplate(value: string | null): AutoReplyTemplateKey | undefined {
  return ["pullRequest", "issue", "received", "started", "failed", "completed"].includes(
    value ?? "",
  )
    ? (value as AutoReplyTemplateKey)
    : undefined;
}

function useRepositorySettings(repository: Repository) {
  const intake = useQuery({
    queryKey: webhookSettingsQueryKey(repository.id),
    queryFn: () => investigationApi.repositoryWebhookSettings(repository.id),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const replies = useQuery({
    queryKey: autoReplySettingsQueryKey(repository.id),
    queryFn: () => investigationApi.repositoryAutoReplySettings(repository.id),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return { intake, replies };
}

function RepositoryDirectoryEntry({
  repository,
  onOpen,
}: {
  repository: Repository;
  onOpen: () => void;
}) {
  const { intake, replies } = useRepositorySettings(repository);
  const intakeStatus = intake.isError
    ? "Unavailable"
    : intake.data
      ? intake.data.enabled || intake.data.e2eEnabled
        ? "On"
        : "Off"
      : "Loading…";
  const replyStatus = replies.isError
    ? "Unavailable"
    : replies.data
      ? replies.data.enabled
        ? "On"
        : "Off"
      : "Loading…";
  return (
    <ButtonBase className="repository-directory-entry" onClick={onOpen}>
      <Box className="repository-directory-icon" sx={{ color: "primary.main" }}>
        <FolderRounded />
      </Box>
      <Box className="repository-directory-name">
        <Typography component="span" variant="h6">
          {repository.fullName}
        </Typography>
        <Typography component="span" variant="body2" color="text.secondary">
          {repository.id}
        </Typography>
        <Typography
          className="repository-directory-mobile-status"
          component="span"
          variant="caption"
          color="text.secondary"
        >
          Intake {intakeStatus.toLowerCase()} · Replies {replyStatus.toLowerCase()}
        </Typography>
      </Box>
      <Box className="repository-directory-status" sx={{ color: "text.secondary" }}>
        <span>Intake {intakeStatus.toLowerCase()}</span>
        <span>Automatic replies {replyStatus.toLowerCase()}</span>
      </Box>
      <ChevronRightRounded sx={{ color: "text.secondary", flexShrink: 0 }} />
    </ButtonBase>
  );
}

function RepositoryOverview({
  repository,
  onTab,
}: {
  repository: Repository;
  onTab: (tab: SettingsTab) => void;
}) {
  const { intake, replies } = useRepositorySettings(repository);
  const links = [
    ["Pull requests", "/pull-requests"],
    ["Issues", "/issues"],
    ["Tasks", "/tasks"],
    ["Comments", "/comments"],
    ["Webhook events", "/webhooks"],
  ];
  return (
    <Stack spacing={3}>
      <Surface sx={{ p: { xs: 2, sm: 3 } }}>
        <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
          Review work
        </Typography>
        <Box className="repository-shortcuts">
          {links.map(([label, path]) => (
            <Button
              key={path}
              component={Link}
              to={path + "?repositoryId=" + encodeURIComponent(repository.id)}
              className="repository-shortcut"
              endIcon={<ChevronRightRounded />}
            >
              <Box component="span">
                <strong>{label}</strong>
              </Box>
            </Button>
          ))}
        </Box>
        <Box sx={{ mt: 1 }}>
          <ImportWorkItemButton repository={repository} />
        </Box>
      </Surface>
      <Surface sx={{ p: { xs: 2, sm: 3 } }}>
        <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
          Automation
        </Typography>
        <Box className="repository-summary-row">
          <Box>
            <Typography sx={{ fontWeight: 500 }}>Event intake</Typography>
            <Typography variant="body2" color="text.secondary">
              {intake.isError
                ? "Intake settings unavailable."
                : intake.data
                  ? "Assignments " +
                    (intake.data.enabled ? "on" : "off") +
                    " · Trusted E2E commands " +
                    (intake.data.e2eEnabled ? "on" : "off")
                  : "Loading saved intake settings…"}
            </Typography>
          </Box>
          <Button aria-label="Configure event intake" onClick={() => onTab("intake")}>
            Configure
          </Button>
        </Box>
        <Box className="repository-summary-row">
          <Box>
            <Typography sx={{ fontWeight: 500 }}>Automatic replies</Typography>
            <Typography variant="body2" color="text.secondary">
              {replies.isError
                ? "Reply settings unavailable."
                : replies.data
                  ? "Conclusions " +
                    (replies.data.enabled ? "on" : "off") +
                    " · Assignment progress " +
                    (replies.data.progressEnabled ? "on" : "off")
                  : "Loading saved reply settings…"}
            </Typography>
          </Box>
          <Button aria-label="Configure automatic replies" onClick={() => onTab("replies")}>
            Configure
          </Button>
        </Box>
        <Box className="repository-summary-row">
          <Box>
            <Typography sx={{ fontWeight: 500 }}>Workspace scheduling</Typography>
            <Typography variant="body2" color="text.secondary">
              All repositories
            </Typography>
          </Box>
          <Button onClick={() => onTab("scheduling")}>Open</Button>
        </Box>
      </Surface>
      <Box className="repository-overview-footer">
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
          Repository ID: {repository.id}
        </Typography>
        <Button
          component="a"
          href={"https://github.com/" + repository.fullName}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open on GitHub
        </Button>
      </Box>
    </Stack>
  );
}

export default function RepositoriesPage() {
  const { session } = useInvestigationSession();
  const [params, setParams] = useSearchParams();
  const search = (params.get("q") ?? "").slice(0, 200);
  const setSearch = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set("q", value.slice(0, 200));
    else next.delete("q");
    setParams(next, { replace: true });
  };
  const guardedAction = useGuardedAction();
  const repositoryIds = session.user?.repositoryIds ?? [];
  const query = useQuery({
    queryKey: ["investigation-repositories"],
    queryFn: investigationApi.repositories,
    enabled: repositoryIds.length > 0,
  });
  const selectedId = params.get("repositoryId") ?? params.get("id");
  const repositories = (query.data?.items ?? []).filter((item) => repositoryIds.includes(item.id));
  const selected = repositories.find((item) => item.id === selectedId);
  const tab = repositorySettingsTab(params.get("tab"));
  const replyTemplate = repositoryReplyTemplate(params.get("replyTemplate"));
  const open = (repositoryId?: string, nextTab: SettingsTab = "overview") =>
    guardedAction(() => {
      const next = new URLSearchParams();
      if (search) next.set("q", search);
      if (nextTab === "scheduling") next.set("tab", "scheduling");
      else if (repositoryId) {
        next.set("repositoryId", repositoryId);
        next.set("tab", nextTab);
        if (repositoryId === selectedId && replyTemplate) next.set("replyTemplate", replyTemplate);
      }
      setParams(next);
    });
  const filtered = repositories.filter((item) =>
    (item.fullName + " " + item.id + " " + item.githubRepositoryId)
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );

  if (tab === "scheduling")
    return (
      <Stack spacing={3} className="repository-workspace">
        <Box>
          <Button startIcon={<ArrowBackRounded />} onClick={() => open()}>
            Back to repositories
          </Button>
        </Box>
        <PageHeading title="Workspace scheduling" subtitle="All repositories" />
        <SchedulerPanel />
      </Stack>
    );
  if (selected)
    return (
      <Stack spacing={3} className="repository-workspace">
        <Box>
          <Button startIcon={<ArrowBackRounded />} onClick={() => open()}>
            Back to repositories
          </Button>
        </Box>
        <PageHeading title={selected.fullName} />
        <Tabs
          value={tab}
          onChange={(_, value: SettingsTab) => open(selected.id, value)}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          slots={{ scrollButtons: RepositoryTabScrollButton }}
          aria-label="Repository settings"
          sx={{
            "& .MuiTab-root": {
              minWidth: 0,
              px: { xs: 0.75, sm: 2 },
              fontSize: { xs: 13, sm: 14 },
            },
          }}
        >
          {repositorySettingsTabs
            .filter((value) => value !== "scheduling")
            .map((value) => (
              <Tab
                key={value}
                value={value}
                label={tabLabels[value]}
                id={"repository-tab-" + value}
                aria-controls={"repository-panel-" + value}
              />
            ))}
        </Tabs>
        <Box
          role="tabpanel"
          id={"repository-panel-" + tab}
          aria-labelledby={"repository-tab-" + tab}
          className="repository-settings-body"
        >
          {tab === "overview" && (
            <RepositoryOverview repository={selected} onTab={(value) => open(selected.id, value)} />
          )}
          {tab === "intake" && (
            <Surface sx={{ p: { xs: 2, sm: 3 } }}>
              <RepositoryWebhookSettingsPanel repository={selected} />
            </Surface>
          )}
          {tab === "replies" && (
            <Surface sx={{ p: { xs: 2, sm: 3 } }}>
              <RepositoryAutoReplySettingsPanel
                repository={selected}
                selectedTemplate={replyTemplate}
                onTemplateChange={(value) => {
                  const next = new URLSearchParams();
                  next.set("repositoryId", selected.id);
                  next.set("tab", "replies");
                  next.set("replyTemplate", value);
                  if (search) next.set("q", search);
                  setParams(next, { replace: true });
                }}
              />
            </Surface>
          )}
        </Box>
      </Stack>
    );
  return (
    <Stack spacing={3} className="repository-workspace">
      <PageHeading
        title="Repositories"
        action={<Button onClick={() => open(undefined, "scheduling")}>Workspace scheduling</Button>}
      />
      {repositoryIds.length > 0 && query.isPending && (
        <CircularProgress size={28} aria-label="Loading repositories" />
      )}
      {query.isError && repositoryIds.length > 0 && (
        <Alert severity="error">
          {query.error.message}
          <Button onClick={() => void query.refetch()}>Retry directory</Button>
        </Alert>
      )}
      {selectedId && !query.isPending && !query.isError ? (
        <EmptyState
          title="Repository not available"
          description="This repository is outside your current access or no longer available."
          action={<Button onClick={() => open()}>View repositories</Button>}
        />
      ) : !repositoryIds.length || (query.data && !repositories.length) ? (
        <EmptyState
          title="No repositories in your scope"
          description="Ask an administrator to register a repository and grant access."
          icon={<FolderRounded />}
          action={
            <Button component={Link} to="/account">
              My account
            </Button>
          }
        />
      ) : (
        repositories.length > 0 && (
          <>
            <Box className="repository-directory-tools">
              <TextField
                label="Find a repository"
                placeholder="Search by name or ID"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                slotProps={{
                  htmlInput: { maxLength: 200 },
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchRounded />
                      </InputAdornment>
                    ),
                  },
                }}
              />
              <Typography color="text.secondary" variant="body2" aria-live="polite">
                {filtered.length} {filtered.length === 1 ? "repository" : "repositories"}
              </Typography>
            </Box>
            {filtered.length ? (
              <Surface sx={{ overflow: "hidden" }}>
                {filtered.map((repository) => (
                  <RepositoryDirectoryEntry
                    key={repository.id}
                    repository={repository}
                    onOpen={() => open(repository.id)}
                  />
                ))}
              </Surface>
            ) : (
              <EmptyState
                title="No matching repositories"
                action={<Button onClick={() => setSearch("")}>Clear search</Button>}
              />
            )}
          </>
        )
      )}
    </Stack>
  );
}
