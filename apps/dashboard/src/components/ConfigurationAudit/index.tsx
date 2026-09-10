import type {
  ConfigurationAuditEvent,
  ConfigurationAuditSummary,
  OperatorPrincipal,
} from "@agentic-review/contracts";
import CloseIcon from "@mui/icons-material/Close";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Drawer,
  IconButton,
  Pagination,
  Skeleton,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { DataTable, DetailsGrid } from "@/components/ui";
import { configurationAudit } from "@/services/configuration-audit";
import { useOperatorSession } from "@/state/session";
import {
  type ConfigurationAuditScope,
  configurationAuditActionLabels,
  configurationAuditDetailKey,
  configurationAuditListKey,
  configurationAuditMatchesSummary,
  configurationAuditRevisionLabel,
  configurationAuditRowKey,
  configurationAuditSessionKey,
} from "./state";
import "./index.css";
import { repositorySnapshotSchedulingLabels } from "./snapshot";

const pageSize = 20;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed. Try again.";
}

function Actor({ actor }: { readonly actor: OperatorPrincipal }) {
  return (
    <div className="configuration-audit-identity configuration-audit-break">
      <span>
        <Typography variant="body2" component="span" color="text.secondary">
          Subject:{" "}
        </Typography>
        <code>{actor.subject}</code>
      </span>
      <span>
        <Typography variant="body2" component="span" color="text.secondary">
          Issuer:{" "}
        </Typography>
        <code>{actor.issuer}</code>
      </span>
    </div>
  );
}

function RecordedSnapshot({ event }: { readonly event: ConfigurationAuditEvent }) {
  const scheduling =
    event.source === "repository" ? repositorySnapshotSchedulingLabels(event.snapshot) : null;
  return (
    <>
      <Alert className="configuration-audit-note" severity={"info"}>
        <AlertTitle>
          {event.source === "repository"
            ? "Recorded repository snapshot"
            : "Recorded operation metadata"}
        </AlertTitle>
        {event.source === "repository"
          ? "These settings were stored with this operation. This history does not record every connection poll or repository rename. This is not the current repository state."
          : event.action === "draft_saved"
            ? "This event retained the template revision and draft revision only. The old draft body was not retained and cannot be reconstructed from the current draft."
            : "This is the metadata retained for this operation. It does not contain an old draft body or substitute current template content."}
      </Alert>
      <Typography variant="h6" component="h3">
        Stored snapshot
      </Typography>
      {scheduling && (
        <div>
          <DetailsGrid
            columns={2}
            items={[
              { key: "active", label: "Active lease limit", value: scheduling.active },
              { key: "queue", label: "Admitted queue limit", value: scheduling.queue },
            ]}
          />
        </div>
      )}
      <pre className="configuration-audit-snapshot">{JSON.stringify(event.snapshot, null, 2)}</pre>
    </>
  );
}

function EventDetails({
  scope,
  summary,
  principal,
  session,
  onClose,
  refreshAccess,
}: {
  readonly scope: ConfigurationAuditScope;
  readonly summary: ConfigurationAuditSummary;
  readonly principal: OperatorPrincipal;
  readonly session: string;
  readonly onClose: () => void;
  readonly refreshAccess: () => Promise<void>;
}) {
  const query = useQuery({
    queryKey: configurationAuditDetailKey(
      configurationAudit.mode,
      scope,
      principal,
      session,
      summary,
    ),
    queryFn: async ({ signal }) => {
      signal.throwIfAborted();
      const event =
        scope.kind === "repository"
          ? await configurationAudit.getRepositoryConfigurationAudit(
              scope.repositoryId,
              summary.source,
              summary.id,
              summary,
            )
          : await configurationAudit.getGlobalConfigurationAudit(summary.id, summary);
      signal.throwIfAborted();
      if (!configurationAuditMatchesSummary(event, summary))
        throw new Error("The audit detail does not match the selected recorded event.");
      return event;
    },
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const event =
    !query.isError &&
    !query.isFetching &&
    query.data &&
    configurationAuditMatchesSummary(query.data, summary)
      ? query.data
      : null;
  return (
    <Drawer
      open
      anchor="right"
      onClose={(_event, reason) => {
        if (reason === "escapeKeyDown" || reason === "backdropClick") onClose();
      }}
      slotProps={{
        paper: {
          role: "dialog",
          "aria-label": "Configuration event",
          sx: { width: { xs: "100%", sm: 760 }, maxWidth: "100%" },
        },
      }}
    >
      <Box sx={{ px: { xs: 2, sm: 3 }, py: 3, display: "flex", alignItems: "center", gap: 2 }}>
        <Typography variant="h6" sx={{ flex: 1 }}>
          {"Configuration event"}
        </Typography>
        {
          <Button
            onClick={() => void refreshAccess()}
            variant="outlined"
            startIcon={<RefreshIcon />}
          >
            Refresh access
          </Button>
        }
        <IconButton aria-label="Close" disabled={false} onClick={() => onClose()}>
          <CloseIcon />
        </IconButton>
      </Box>
      <Box sx={{ px: { xs: 2, sm: 3 }, pb: 3, overflowY: "auto", flex: 1 }}>
        {query.isError ? (
          <Alert
            action={
              <Button onClick={() => void query.refetch()} variant="outlined">
                Try again
              </Button>
            }
            severity={"error"}
          >
            <AlertTitle>{"Could not load configuration event"}</AlertTitle>
            {errorMessage(query.error)}
          </Alert>
        ) : !event ? (
          <Skeleton variant="rounded" height={8 * 24} aria-label="Loading" />
        ) : (
          <>
            <div className={"configuration-audit-note"}>
              <DetailsGrid
                columns={2}
                items={[
                  {
                    key: "action",
                    label: "Operation",
                    value: configurationAuditActionLabels[event.action],
                  },
                  {
                    key: "time",
                    label: "Recorded at (UTC)",
                    value: <time dateTime={event.createdAt}>{event.createdAt}</time>,
                  },
                  { key: "actor", label: "Actor", value: <Actor actor={event.actor} /> },
                  { key: "source", label: "Source", value: event.source },
                  {
                    key: "id",
                    label: "Event ID",
                    value: <code className="configuration-audit-break">{event.id}</code>,
                  },
                  {
                    key: "entity",
                    label: "Recorded entity ID",
                    value: <code className="configuration-audit-break">{event.entityId}</code>,
                  },
                  {
                    key: "scope",
                    label: "Scope",
                    value: event.repositoryId ? (
                      <code className="configuration-audit-break">{event.repositoryId}</code>
                    ) : (
                      "Global"
                    ),
                  },
                  {
                    key: "revision",
                    label: "Revision",
                    value: configurationAuditRevisionLabel(event),
                  },
                ]}
              />
            </div>
            <RecordedSnapshot event={event} />
          </>
        )}
      </Box>
    </Drawer>
  );
}

function AuditSession({
  scope,
  principal,
  session,
  refreshAccess,
}: {
  readonly scope: ConfigurationAuditScope;
  readonly principal: OperatorPrincipal;
  readonly session: string;
  readonly refreshAccess: () => Promise<void>;
}) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ConfigurationAuditSummary | null>(null);
  const query = useQuery({
    queryKey: configurationAuditListKey(
      configurationAudit.mode,
      scope,
      principal,
      session,
      page,
      pageSize,
    ),
    queryFn: async ({ signal }) => {
      signal.throwIfAborted();
      const result =
        scope.kind === "repository"
          ? await configurationAudit.listRepositoryConfigurationAudit(scope.repositoryId, {
              page,
              pageSize,
            })
          : await configurationAudit.listGlobalConfigurationAudit({
              page,
              pageSize,
              ...(scope.templateId ? { templateId: scope.templateId } : {}),
            });
      signal.throwIfAborted();
      return result;
    },
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const loaded = !query.isError && !query.isFetching ? query.data : undefined;
  const refresh = () => {
    setSelected(null);
    void query.refetch();
  };
  return (
    <div className="configuration-audit">
      {configurationAudit.mode === "sample" && (
        <Alert className="configuration-audit-note" severity={"info"}>
          <AlertTitle>{"Sample configuration history"}</AlertTitle>
          {"These fixed illustrative snapshots are independent of current preview settings."}
        </Alert>
      )}
      <div className="configuration-audit-toolbar">
        <div>
          <Typography variant="h6" component="h3">
            Configuration activity
          </Typography>
          <Typography variant="body2" component="p" color="text.secondary">
            {scope.kind === "repository" ? (
              "Recorded repository settings, prompt bindings, and validation profile operations for this repository."
            ) : scope.templateId ? (
              <>
                Recorded global activity associated with template{" "}
                <code className="configuration-audit-break">{scope.templateId}</code>.
              </>
            ) : (
              "Shared prompt templates and global default bindings. Repository overrides appear in each repository's configuration activity."
            )}
          </Typography>
        </div>
        <Button
          loading={query.isFetching}
          onClick={refresh}
          variant="outlined"
          startIcon={<RefreshIcon />}
        >
          Refresh activity
        </Button>
      </div>
      <Typography
        className="configuration-audit-note"
        variant="body2"
        component="p"
        color="text.secondary"
      >
        Events are newest first. Events with the same timestamp have a stable display order; it does
        not establish causality. Inspect an event to see only the snapshot retained at that
        operation.
      </Typography>
      {query.isError ? (
        <Alert
          action={
            <Button onClick={refresh} variant="outlined">
              Try again
            </Button>
          }
          severity={"error"}
        >
          <AlertTitle>{"Could not load configuration activity"}</AlertTitle>
          {errorMessage(query.error)}
        </Alert>
      ) : !loaded ? (
        <Skeleton variant="rounded" height={5 * 24} aria-label="Loading" />
      ) : (
        <>
          <DataTable<ConfigurationAuditSummary>
            rows={loaded.items}
            columns={[
              {
                id: "operation",
                label: "Recorded operation",
                width: 260,
                render: (event) => {
                  return (
                    <div className="configuration-audit-identity">
                      <Typography variant="subtitle1" component="span" sx={{ fontWeight: 500 }}>
                        {configurationAuditActionLabels[event.action]}
                      </Typography>
                      <Typography variant="body2" component="span" color="text.secondary">
                        {configurationAuditRevisionLabel(event)}
                      </Typography>
                      <code className="configuration-audit-break">{event.entityId}</code>
                      <Chip size="medium" label={event.source}></Chip>
                    </div>
                  );
                },
              },
              {
                id: "actor",
                label: "Actor",
                render: (event) => {
                  return <Actor actor={event.actor} />;
                },
              },
              {
                id: "createdAt",
                label: "Recorded at",
                width: 185,
                render: (row) => {
                  const value = row.createdAt;
                  return (
                    <time dateTime={value} title={value}>
                      {new Date(value).toLocaleString("en-US")}
                    </time>
                  );
                },
              },
              {
                id: "inspect",
                label: "",
                width: 90,
                render: (event) => {
                  return (
                    <Button
                      onClick={() => setSelected(event)}
                      aria-label={`Inspect ${event.source} event ${event.id}`}
                      variant={"text"}
                    >
                      Inspect
                    </Button>
                  );
                },
              },
            ]}
            getRowId={configurationAuditRowKey}
            emptyTitle={
              loaded.total === 0
                ? "No configuration events were recorded for this scope."
                : "No events on this page. Choose a previous page or refresh activity."
            }
          />
          {loaded.total > pageSize ? (
            <div className="configuration-audit-pagination">
              <Typography variant="body2" color="text.secondary">
                {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, loaded.total)} of{" "}
                {loaded.total}
              </Typography>
              <Pagination
                page={page}
                count={Math.ceil(loaded.total / pageSize)}
                onChange={(_event, nextPage) => {
                  setSelected(null);
                  setPage(nextPage);
                }}
              />
            </div>
          ) : null}
        </>
      )}
      {loaded && selected ? (
        <EventDetails
          key={JSON.stringify(
            configurationAuditDetailKey(
              configurationAudit.mode,
              scope,
              principal,
              session,
              selected,
            ),
          )}
          scope={scope}
          summary={selected}
          principal={principal}
          session={session}
          onClose={() => setSelected(null)}
          refreshAccess={refreshAccess}
        />
      ) : null}
    </div>
  );
}

function AuditAccess({
  scope,
  enabled,
}: {
  readonly scope: ConfigurationAuditScope;
  readonly enabled: boolean;
}) {
  const access = useOperatorAccess(scope.kind === "repository" ? scope.repositoryId : undefined);
  const { initialState } = useOperatorSession();
  const mayRead =
    enabled &&
    access.ready &&
    !access.error &&
    (scope.kind === "repository"
      ? access.can("read")
      : access.platformAdministrator && !access.checking);
  if (access.pending || access.checking)
    return <Skeleton variant="rounded" height={3 * 24} aria-label="Loading" />;
  if (!mayRead || !access.principal)
    return (
      <Alert
        action={
          <Button onClick={() => void access.refresh()} variant="outlined">
            Refresh access
          </Button>
        }
        severity={"info"}
      >
        <AlertTitle>{"Configuration activity is unavailable"}</AlertTitle>
        {scope.kind === "repository"
          ? "Verify repository read access to inspect configuration events."
          : "Verify platform administrator access to inspect global prompt events."}
      </Alert>
    );
  if (configurationAudit.mode === "sample" && scope.kind === "global")
    return (
      <Alert severity={"info"}>
        <AlertTitle>{"Configuration activity is unavailable in Sample mode"}</AlertTitle>
        {
          "Shared prompt history is unavailable in sample mode. Repository activity contains fixed illustrative snapshots."
        }
      </Alert>
    );
  const session = JSON.stringify([
    initialState?.authenticationEpoch ?? 0,
    access.identityKey,
    access.context?.platformAdministrator,
    access.context?.repository,
  ]);
  return (
    <AuditSession
      key={JSON.stringify(
        configurationAuditSessionKey(configurationAudit.mode, scope, access.principal, session),
      )}
      scope={scope}
      principal={access.principal}
      session={session}
      refreshAccess={access.refresh}
    />
  );
}

export function RepositoryConfigurationActivity({
  repositoryId,
}: {
  readonly repositoryId: string;
}) {
  return <AuditAccess scope={{ kind: "repository", repositoryId }} enabled />;
}

export function GlobalPromptActivity({
  templateId,
  enabled = true,
}: {
  readonly templateId?: string;
  readonly enabled?: boolean;
}) {
  return (
    <AuditAccess
      scope={{ kind: "global", ...(templateId ? { templateId } : {}) }}
      enabled={enabled}
    />
  );
}
