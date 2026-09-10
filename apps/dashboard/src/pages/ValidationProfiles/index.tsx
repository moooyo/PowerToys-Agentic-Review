import type {
  ValidationProfileVersion,
  ValidationProfileVersionSummary,
} from "@agentic-review/contracts";
import { Add, Refresh } from "@mui/icons-material";
import { Alert, AlertTitle, Box, Button, Chip, Stack, Typography } from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ConfigurationScopeGuard,
  useConfigurationAvailable,
} from "@/components/ConfigurationScopeGuard";
import { OperatorAccessGate, useOperatorAccess } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import { RepositoryScopeUnavailable, useRepositoryScope } from "@/components/RepositoryScope";
import { DataTable, EmptyState, notify } from "@/components/ui";
import { configuration } from "@/services/configuration";
import {
  collectProfileBindings,
  configurationErrorMessage,
  targetLabels,
  workflowLabels,
} from "./forms";
import { ProfileDetails } from "./ProfileDetails";
import { ProfileEditor } from "./ProfileEditor";
import "./index.css";

function RepositoryProfiles({
  repositoryId,
  repositoryName,
}: {
  repositoryId: string;
  repositoryName: string;
}) {
  const available = useConfigurationAvailable();
  const access = useOperatorAccess(repositoryId);
  const canConfigure = available && access.can("configure");
  const allowsConfigure = access.allows("configure");
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [detail, setDetail] = useState<ValidationProfileVersionSummary | null>(null);
  const [editor, setEditor] = useState<{ source?: ValidationProfileVersionSummary } | null>(null);
  const listQuery = useQuery({
    queryKey: ["validation-profiles", repositoryId, "list", page, pageSize],
    queryFn: () => configuration.listProfiles(repositoryId, { page, pageSize }),
    retry: false,
  });
  const bindingsQuery = useQuery({
    queryKey: ["validation-profiles", repositoryId, "bindings"],
    queryFn: () =>
      collectProfileBindings(repositoryId, (id, query) =>
        configuration.listProfileBindings(id, query),
      ),
    retry: false,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["validation-profiles", repositoryId] });
  const createProfile = () => {
    if (canConfigure) setEditor({});
  };
  const createVersion = (source: ValidationProfileVersionSummary) => {
    if (!canConfigure) return;
    setEditor({ source });
    setDetail(null);
  };
  const published = (profile: ValidationProfileVersion) => {
    setEditor(null);
    setDetail(profile);
    notify(`Version ${profile.version} published. Select a repository binding to use it.`);
    void refresh();
  };
  return (
    <section className="validation-profiles-page" aria-labelledby="validation-profiles-title">
      <PageHeader
        eyebrow="Configuration"
        title="Validation profiles"
        titleId="validation-profiles-title"
        description={`Manage workflow commands and published versions for ${repositoryName}.`}
        actions={
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            <Button
              variant="outlined"
              startIcon={<Refresh />}
              loading={listQuery.isFetching || bindingsQuery.isFetching}
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
            {allowsConfigure && (
              <Button
                variant="contained"
                startIcon={<Add />}
                disabled={!canConfigure}
                onClick={createProfile}
              >
                Create profile
              </Button>
            )}
          </Stack>
        }
      />
      {import.meta.env.DEV && (
        <Alert className="validation-profiles-notice" severity="info">
          <AlertTitle>Sample data</AlertTitle>This preview uses sample profiles. Changes affect the
          preview only and do not execute commands.
        </Alert>
      )}
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        {allowsConfigure
          ? "Publish a version, then bind it to this repository. Published versions stay read-only; bindings control which version is enabled for future work."
          : "View published workflow configurations and repository bindings. Repository configuration permission is required to publish versions or change bindings."}
      </Typography>
      {bindingsQuery.isError && (
        <Alert
          className="validation-profiles-notice"
          severity="error"
          action={
            <Button color="inherit" onClick={() => void bindingsQuery.refetch()}>
              Reload bindings
            </Button>
          }
        >
          <AlertTitle>Current bindings are unavailable</AlertTitle>
          {configurationErrorMessage(bindingsQuery.error)}
        </Alert>
      )}
      <Box component="section" aria-labelledby="published-profiles-title">
        <Stack
          direction="row"
          spacing={2}
          sx={{ mb: 2, justifyContent: "space-between", alignItems: "center" }}
        >
          <Typography variant="subtitle1" component="h2" id="published-profiles-title">
            Published profiles
          </Typography>
          <Typography variant="body2" color="text.secondary" role="status">
            {listQuery.isFetching
              ? "Loading profiles…"
              : listQuery.isError
                ? "Profiles unavailable"
                : `${listQuery.data?.total ?? 0} profiles`}
          </Typography>
        </Stack>
        {listQuery.isError ? (
          <Box>
            <Alert
              severity="error"
              action={
                <Button color="inherit" onClick={() => void listQuery.refetch()}>
                  Try again
                </Button>
              }
            >
              <AlertTitle>Could not load validation profiles</AlertTitle>
              {configurationErrorMessage(listQuery.error)}
            </Alert>
          </Box>
        ) : !listQuery.isPending && listQuery.data?.total === 0 ? (
          <EmptyState
            title="No validation profiles"
            description={
              allowsConfigure
                ? "Create a profile to define how this repository is validated."
                : "No validation profiles are available for this repository."
            }
            action={
              allowsConfigure ? (
                <Button variant="contained" disabled={!canConfigure} onClick={createProfile}>
                  Create profile
                </Button>
              ) : undefined
            }
          />
        ) : (
          <DataTable<ValidationProfileVersionSummary>
            ariaLabel="Validation profiles"
            getRowId={(item) => item.profileId}
            rows={listQuery.data?.items ?? []}
            loading={listQuery.isPending}
            emptyTitle="No validation profiles"
            pagination={{
              page,
              pageSize,
              total: listQuery.data?.total ?? 0,
              onChange: (nextPage, nextSize) => {
                setPage(nextSize === pageSize ? nextPage : 1);
                setPageSize(nextSize);
              },
            }}
            columns={[
              {
                id: "name",
                label: "Profile",
                minWidth: 220,
                render: (item) => (
                  <>
                    <Button className="validation-profiles-name" onClick={() => setDetail(item)}>
                      {item.name}
                    </Button>
                    <div className="validation-profiles-secondary">
                      Latest version {item.version} · {item.required ? "Required" : "Optional"}
                    </div>
                  </>
                ),
              },
              {
                id: "workflowKind",
                label: "Workflow",
                minWidth: 180,
                render: (item) => workflowLabels[item.workflowKind],
              },
              {
                id: "target",
                label: "Target",
                minWidth: 140,
                render: (item) => targetLabels[item.target],
              },
              {
                id: "binding",
                label: "Repository binding",
                minWidth: 180,
                render: (item) => {
                  if (bindingsQuery.isError)
                    return <Typography color="error">Unavailable</Typography>;
                  if (bindingsQuery.isPending)
                    return <Typography color="text.secondary">Loading…</Typography>;
                  const binding = bindingsQuery.data?.find(
                    (candidate) => candidate.profileId === item.profileId,
                  );
                  return binding ? (
                    <>
                      <Chip
                        color={binding.enabled ? "primary" : "default"}
                        variant="outlined"
                        label={binding.enabled ? "Enabled" : "Disabled"}
                      />
                      <div className="validation-profiles-secondary">
                        {binding.profileVersionId === item.id
                          ? `Version ${item.version}`
                          : "Different published version"}
                      </div>
                    </>
                  ) : (
                    <Chip variant="outlined" label="Not bound" />
                  );
                },
              },
              {
                id: "publishedAt",
                label: "Published",
                minWidth: 160,
                render: (item) => (
                  <span className="validation-profiles-date">{item.publishedAt}</span>
                ),
              },
              {
                id: "actions",
                label: "Actions",
                minWidth: 230,
                render: (item) => (
                  <Stack direction="row" spacing={1}>
                    <Button variant="outlined" onClick={() => setDetail(item)}>
                      {allowsConfigure ? "Manage" : "View"}
                    </Button>
                    {allowsConfigure && (
                      <Button disabled={!canConfigure} onClick={() => createVersion(item)}>
                        New version
                      </Button>
                    )}
                  </Stack>
                ),
              },
            ]}
          />
        )}
      </Box>
      {detail && (
        <ProfileDetails
          key={detail.profileId}
          repositoryId={repositoryId}
          profile={detail}
          onClose={() => setDetail(null)}
          onNewVersion={() => createVersion(detail)}
        />
      )}
      {editor && (
        <ProfileEditor
          key={editor.source?.profileId ?? "create"}
          repositoryId={repositoryId}
          {...(editor.source ? { source: editor.source } : {})}
          onClose={() => setEditor(null)}
          onPublished={published}
        />
      )}
    </section>
  );
}

export default function ValidationProfilesPage() {
  const scope = useRepositoryScope();
  if (scope.ready && !scope.repositoryId)
    return (
      <section className="validation-profiles-page" aria-labelledby="validation-profiles-title">
        <PageHeader
          eyebrow="Configuration"
          title="Validation profiles"
          titleId="validation-profiles-title"
          description="Choose a repository to manage its workflow commands and published versions."
        />
        <EmptyState
          title="Choose a repository"
          description="Select a specific repository in the sidebar to view, publish, or bind validation profiles."
        />
      </section>
    );
  return (
    <OperatorAccessGate repositoryId={scope.repositoryId}>
      <ConfigurationScopeGuard
        key={scope.key}
        scopeKey={scope.key}
        available={scope.ready && !scope.error && scope.repositoryId !== undefined}
        fallback={<RepositoryScopeUnavailable />}
      >
        <RepositoryProfiles
          key={scope.key}
          repositoryId={scope.repositoryId ?? ""}
          repositoryName={scope.label}
        />
      </ConfigurationScopeGuard>
    </OperatorAccessGate>
  );
}
