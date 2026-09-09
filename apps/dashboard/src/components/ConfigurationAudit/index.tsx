import type {
  ConfigurationAuditEvent,
  ConfigurationAuditSummary,
  OperatorPrincipal,
} from "@agentic-review/contracts";
import { ReloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useModel } from "@umijs/max";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Pagination,
  Skeleton,
  Table,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { configurationAudit } from "@/services/configuration-audit";
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
        <Typography.Text type="secondary">Subject: </Typography.Text>
        <code>{actor.subject}</code>
      </span>
      <span>
        <Typography.Text type="secondary">Issuer: </Typography.Text>
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
      <Alert
        className="configuration-audit-note"
        type="info"
        showIcon
        title={
          event.source === "repository"
            ? "Recorded repository snapshot"
            : "Recorded operation metadata"
        }
        description={
          event.source === "repository"
            ? "These settings were stored with this operation. This history does not record every connection poll or repository rename. This is not the current repository state."
            : event.action === "draft_saved"
              ? "This event retained the template revision and draft revision only. The old draft body was not retained and cannot be reconstructed from the current draft."
              : "This is the metadata retained for this operation. It does not contain an old draft body or substitute current template content."
        }
      />
      <Typography.Title level={5}>Stored snapshot</Typography.Title>
      {scheduling && (
        <Descriptions
          column={1}
          size="small"
          items={[
            { key: "active", label: "Active lease limit", children: scheduling.active },
            { key: "queue", label: "Admitted queue limit", children: scheduling.queue },
          ]}
        />
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
      title="Configuration event"
      size={760}
      onClose={onClose}
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void refreshAccess()}>
          Refresh access
        </Button>
      }
    >
      {query.isError ? (
        <Alert
          type="error"
          showIcon
          title="Could not load configuration event"
          description={errorMessage(query.error)}
          action={<Button onClick={() => void query.refetch()}>Try again</Button>}
        />
      ) : !event ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : (
        <>
          <Descriptions
            column={1}
            size="small"
            className="configuration-audit-note"
            items={[
              {
                key: "action",
                label: "Operation",
                children: configurationAuditActionLabels[event.action],
              },
              {
                key: "time",
                label: "Recorded at (UTC)",
                children: <time dateTime={event.createdAt}>{event.createdAt}</time>,
              },
              { key: "actor", label: "Actor", children: <Actor actor={event.actor} /> },
              { key: "source", label: "Source", children: event.source },
              {
                key: "id",
                label: "Event ID",
                children: <code className="configuration-audit-break">{event.id}</code>,
              },
              {
                key: "entity",
                label: "Recorded entity ID",
                children: <code className="configuration-audit-break">{event.entityId}</code>,
              },
              {
                key: "scope",
                label: "Scope",
                children: event.repositoryId ? (
                  <code className="configuration-audit-break">{event.repositoryId}</code>
                ) : (
                  "Global"
                ),
              },
              {
                key: "revision",
                label: "Revision",
                children: configurationAuditRevisionLabel(event),
              },
            ]}
          />
          <RecordedSnapshot event={event} />
        </>
      )}
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
        <Alert
          className="configuration-audit-note"
          showIcon
          type="info"
          title="Sample configuration history"
          description="These fixed illustrative snapshots are independent of current preview settings."
        />
      )}
      <div className="configuration-audit-toolbar">
        <div>
          <Typography.Title level={5}>Configuration activity</Typography.Title>
          <Typography.Paragraph type="secondary">
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
          </Typography.Paragraph>
        </div>
        <Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={refresh}>
          Refresh activity
        </Button>
      </div>
      <Typography.Paragraph type="secondary" className="configuration-audit-note">
        Events are newest first. Events with the same timestamp have a stable display order; it does
        not establish causality. Inspect an event to see only the snapshot retained at that
        operation.
      </Typography.Paragraph>
      {query.isError ? (
        <Alert
          type="error"
          showIcon
          title="Could not load configuration activity"
          description={errorMessage(query.error)}
          action={<Button onClick={refresh}>Try again</Button>}
        />
      ) : !loaded ? (
        <Skeleton active paragraph={{ rows: 5 }} />
      ) : (
        <>
          <Table<ConfigurationAuditSummary>
            size="small"
            rowKey={configurationAuditRowKey}
            dataSource={loaded.items}
            pagination={false}
            scroll={{ x: 720 }}
            columns={[
              {
                title: "Recorded operation",
                key: "operation",
                width: 260,
                render: (_: unknown, event) => (
                  <div className="configuration-audit-identity">
                    <Typography.Text strong>
                      {configurationAuditActionLabels[event.action]}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {configurationAuditRevisionLabel(event)}
                    </Typography.Text>
                    <code className="configuration-audit-break">{event.entityId}</code>
                    <Tag>{event.source}</Tag>
                  </div>
                ),
              },
              {
                title: "Actor",
                key: "actor",
                render: (_: unknown, event) => <Actor actor={event.actor} />,
              },
              {
                title: "Recorded at",
                dataIndex: "createdAt",
                width: 185,
                render: (value: string) => (
                  <time dateTime={value} title={value}>
                    {new Date(value).toLocaleString("en-US")}
                  </time>
                ),
              },
              {
                title: "",
                key: "inspect",
                width: 90,
                fixed: "right",
                render: (_: unknown, event) => (
                  <Button
                    type="link"
                    onClick={() => setSelected(event)}
                    aria-label={`Inspect ${event.source} event ${event.id}`}
                  >
                    Inspect
                  </Button>
                ),
              },
            ]}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    loaded.total === 0
                      ? "No configuration events were recorded for this scope."
                      : "No events on this page. Choose a previous page or refresh activity."
                  }
                />
              ),
            }}
          />
          {loaded.total > pageSize ? (
            <div className="configuration-audit-pagination">
              <Pagination
                current={page}
                pageSize={pageSize}
                total={loaded.total}
                showSizeChanger={false}
                onChange={(nextPage) => {
                  setSelected(null);
                  setPage(nextPage);
                }}
                showTotal={(count, range) => `${range[0]}–${range[1]} of ${count}`}
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
  const { initialState } = useModel("@@initialState");
  const mayRead =
    enabled &&
    access.ready &&
    !access.error &&
    (scope.kind === "repository"
      ? access.can("read")
      : access.platformAdministrator && !access.checking);
  if (access.pending || access.checking) return <Skeleton active paragraph={{ rows: 3 }} />;
  if (!mayRead || !access.principal)
    return (
      <Alert
        type="info"
        showIcon
        title="Configuration activity is unavailable"
        description={
          scope.kind === "repository"
            ? "Verify repository read access to inspect configuration events."
            : "Verify platform administrator access to inspect global prompt events."
        }
        action={<Button onClick={() => void access.refresh()}>Refresh access</Button>}
      />
    );
  if (configurationAudit.mode === "sample" && scope.kind === "global")
    return (
      <Alert
        type="info"
        showIcon
        title="Configuration activity is unavailable in Sample mode"
        description="Shared prompt history is unavailable in sample mode. Repository activity contains fixed illustrative snapshots."
      />
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
