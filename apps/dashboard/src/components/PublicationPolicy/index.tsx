import type {
  RepositoryPublicationPolicy as Policy,
  RepositoryPublicationPolicyAuditEvent,
  RepositoryPublicationPolicyUpdateRequest,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Drawer,
  Pagination,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { useEffect, useRef, useState } from "react";
import type { useOperatorAccess } from "@/components/OperatorAccess";
import {
  PublicationAccess,
  publicationAccessDenied,
  publicationError,
  usePublicationReadGuard,
} from "@/components/PublicationPreview/access";
import { publicationQueryRoot, publications } from "@/services/publications";

function PolicyEvent({
  repositoryId,
  selected,
  session,
  refreshAccess,
  onClose,
  onAccessDenied,
}: {
  repositoryId: string;
  selected: RepositoryPublicationPolicyAuditEvent;
  session: string;
  refreshAccess: () => Promise<void>;
  onClose: () => void;
  onAccessDenied: (error: unknown) => void;
}) {
  const query = useQuery({
    queryKey: [...publicationQueryRoot, session, "policy-event", selected.id],
    queryFn: async ({ signal }) => {
      const event = await publications.policyEvent(repositoryId, selected.id, signal);
      if (!Value.Equal(event, selected))
        throw new Error("The policy event differs from the selected immutable record.");
      return event;
    },
    retry: false,
    gcTime: 0,
  });
  useEffect(() => {
    if (publicationAccessDenied(query.error)) onAccessDenied(query.error);
  }, [query.error, onAccessDenied]);
  const event = !query.isError ? query.data : undefined;
  return (
    <Drawer
      open
      title="Publication policy event"
      size={650}
      onClose={onClose}
      extra={<Button onClick={() => void refreshAccess()}>Refresh access</Button>}
    >
      {query.isError ? (
        <Alert
          showIcon
          type="error"
          title="Could not load policy event"
          description={publicationError(query.error)}
        />
      ) : !event ? (
        <Skeleton active />
      ) : (
        <Descriptions
          column={1}
          items={[
            { key: "id", label: "Event ID", children: <code>{event.id}</code> },
            { key: "time", label: "Recorded at", children: event.createdAt },
            {
              key: "actor",
              label: "Actor",
              children: `${event.actor.subject} · ${event.actor.issuer}`,
            },
            {
              key: "versions",
              label: "Version",
              children: `${event.previousVersion} → ${event.version}`,
            },
            {
              key: "previous",
              label: "Previous policy",
              children: event.previousSnapshot.enabled ? "Enabled" : "Disabled",
            },
            {
              key: "new",
              label: "Saved policy",
              children: event.snapshot.enabled ? "Enabled" : "Disabled",
            },
          ]}
        />
      )}
    </Drawer>
  );
}
function PolicySession({
  repositoryId,
  session,
  access,
}: {
  repositoryId: string;
  session: string;
  access: ReturnType<typeof useOperatorAccess>;
}) {
  const client = useQueryClient();
  const [baseline, setBaseline] = useState<Policy | null>(null),
    [enabled, setEnabled] = useState(false),
    [saving, setSaving] = useState(false),
    [failure, setFailure] = useState<unknown>(null),
    [request, setRequest] = useState<RepositoryPublicationPolicyUpdateRequest | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<RepositoryPublicationPolicyAuditEvent | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const policyKey = [...publicationQueryRoot, session, "policy", repositoryId];
  const historyKey = [...publicationQueryRoot, session, "policy-history", repositoryId];
  const eventKey = [...publicationQueryRoot, session, "policy-event"];
  const read = usePublicationReadGuard([policyKey, historyKey, eventKey]);
  const query = useQuery({
    queryKey: policyKey,
    queryFn: ({ signal }) => read.guard.read(() => publications.policy(repositoryId, signal)),
    enabled: !read.denied && !access.checking,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const history = useQuery({
    queryKey: [...historyKey, page],
    queryFn: ({ signal }) =>
      read.guard.read(() =>
        publications.policyActivity({ repositoryId, page, pageSize: 20 }, signal),
      ),
    enabled: historyOpen && !read.denied && !access.checking,
    retry: false,
    gcTime: 0,
  });
  const denied =
    read.denied ||
    publicationAccessDenied(query.error) ||
    publicationAccessDenied(history.error) ||
    publicationAccessDenied(failure);
  useEffect(() => {
    if (!denied && !baseline && query.data) {
      setBaseline(query.data);
      setEnabled(query.data.enabled);
    }
  }, [baseline, query.data, denied]);
  const dirty = baseline !== null && enabled !== baseline.enabled;
  const conflict =
    typeof failure === "object" &&
    failure !== null &&
    "status" in failure &&
    failure.status === 409;
  const reload = async () => {
    if (inFlight.current || denied) return;
    setFailure(null);
    setRequest(null);
    setNotice(null);
    const result = await query.refetch();
    if (result.data && !result.isError) {
      setBaseline(result.data);
      setEnabled(result.data.enabled);
    }
  };
  const save = async () => {
    if (
      !baseline ||
      read.guard.snapshot() ||
      !dirty ||
      conflict ||
      !access.can("configure") ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const input = request ?? {
        changeId: crypto.randomUUID(),
        expectedVersion: baseline.version,
        enabled,
      };
      setRequest(input);
      const result = await publications.updatePolicy(repositoryId, input);
      if (!mounted.current || read.guard.snapshot()) return;
      if (
        result.change.actor.issuer !== access.principal?.issuer ||
        result.change.actor.subject !== access.principal?.subject
      )
        throw new Error("The policy receipt does not match this operator.");
      setBaseline(result.change.snapshot);
      setEnabled(result.change.snapshot.enabled);
      setRequest(null);
      setNotice(
        result.replayed ? "Original policy change recovered." : "Publication policy saved.",
      );
      await client.invalidateQueries({ queryKey: publicationQueryRoot });
    } catch (error) {
      if (!mounted.current) return;
      read.guard.deny(error);
      setFailure(error);
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  if (access.checking) return <Skeleton active paragraph={{ rows: 3 }} />;
  if (denied)
    return (
      <Alert
        showIcon
        type="info"
        title="Publication policy access is unavailable"
        description="Previous policy content has been cleared."
        action={<Button onClick={() => void access.refresh()}>Refresh access</Button>}
      />
    );
  return (
    <Card
      size="small"
      title="Publication policy"
      extra={
        <Button disabled={saving} onClick={() => void access.refresh()}>
          Refresh access
        </Button>
      }
    >
      {query.isError ? (
        <Alert
          showIcon
          type="error"
          title="Could not load publication policy"
          description={publicationError(query.error)}
          action={<Button onClick={() => void reload()}>Try again</Button>}
        />
      ) : !baseline ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : (
        <Space orientation="vertical" className="publication-stack" size="middle">
          <Space wrap>
            <Tag color={baseline.enabled ? "success" : "default"}>
              {baseline.enabled ? "Publication enabled" : "Publication disabled"}
            </Tag>
            <Typography.Text type="secondary">
              Policy version {baseline.version}
              {baseline.version === 0 ? " · Not configured" : ""}
            </Typography.Text>
          </Space>
          <Typography.Paragraph>
            Publication is disabled by default. Enabling this policy permits separately confirmed PR
            reviews and Issue comments. Recording a decision never sends to GitHub. A separate
            runtime publisher credential is also required; the ingestion credential is not used.
          </Typography.Paragraph>
          <Space>
            <Switch
              aria-label="Enable repository publication"
              checked={enabled}
              disabled={saving || !access.can("configure")}
              onChange={(value) => {
                setEnabled(value);
                setRequest(null);
                setFailure(null);
                setNotice(null);
              }}
            />
            <Typography.Text>Enable repository publication</Typography.Text>
          </Space>
          {!access.allows("configure") && (
            <Typography.Text type="secondary">
              Maintainer access or higher is required to change this policy.
            </Typography.Text>
          )}
          {!!failure && (
            <Alert
              showIcon
              type="error"
              title={conflict ? "Publication policy changed" : "Could not save publication policy"}
              description={
                conflict
                  ? "Your selection is retained. Reload the latest policy before applying it again."
                  : publicationError(failure)
              }
            />
          )}
          {notice && <Alert showIcon type="success" title={notice} />}
          <Space wrap>
            <Button
              type="primary"
              loading={saving}
              disabled={!dirty || conflict || !access.can("configure")}
              onClick={() => void save()}
            >
              {request && failure && !conflict
                ? "Retry original policy save"
                : "Save publication policy"}
            </Button>
            <Button disabled={saving} onClick={() => void reload()}>
              Reload latest policy
            </Button>
            {dirty && <Typography.Text type="secondary">Unsaved changes</Typography.Text>}
          </Space>
        </Space>
      )}
      <Collapse
        style={{ marginTop: 20 }}
        activeKey={historyOpen ? ["history"] : []}
        onChange={(keys) => setHistoryOpen(keys.includes("history"))}
        items={[
          {
            key: "history",
            label: "Publication policy history",
            children: history.isError ? (
              <Alert
                showIcon
                type="error"
                title="Could not load policy history"
                description={publicationError(history.error)}
              />
            ) : !history.data ? (
              <Skeleton active />
            ) : (
              <>
                <Table<RepositoryPublicationPolicyAuditEvent>
                  size="small"
                  rowKey="id"
                  pagination={false}
                  dataSource={history.data.items}
                  columns={[
                    { key: "time", title: "Recorded at", dataIndex: "createdAt" },
                    {
                      key: "version",
                      title: "Version",
                      render: (_, event) => `${event.previousVersion} → ${event.version}`,
                    },
                    {
                      key: "policy",
                      title: "Saved policy",
                      render: (_, event) => (event.snapshot.enabled ? "Enabled" : "Disabled"),
                    },
                    {
                      key: "action",
                      title: "Details",
                      render: (_, event) => (
                        <Button
                          aria-label={`Inspect publication policy event ${event.id}`}
                          onClick={() => setSelected(event)}
                        >
                          Inspect
                        </Button>
                      ),
                    },
                  ]}
                  locale={{ emptyText: "No publication policy changes have been recorded." }}
                />
                <Pagination
                  current={page}
                  pageSize={20}
                  total={history.data.total}
                  showSizeChanger={false}
                  hideOnSinglePage
                  onChange={(value) => {
                    setPage(value);
                    setSelected(null);
                  }}
                />
              </>
            ),
          },
        ]}
      />
      {selected && (
        <PolicyEvent
          key={selected.id}
          repositoryId={repositoryId}
          selected={selected}
          session={session}
          refreshAccess={access.refresh}
          onClose={() => setSelected(null)}
          onAccessDenied={(error) => {
            read.guard.deny(error);
            setFailure(error);
          }}
        />
      )}
    </Card>
  );
}
export function PublicationPolicy({ repositoryId }: { repositoryId: string }) {
  return (
    <PublicationAccess repositoryId={repositoryId}>
      {(session, access) => (
        <PolicySession
          key={session}
          repositoryId={repositoryId}
          session={session}
          access={access}
        />
      )}
    </PublicationAccess>
  );
}
