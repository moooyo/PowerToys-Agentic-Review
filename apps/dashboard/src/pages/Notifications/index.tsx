import type {
  NotificationItem,
  NotificationListQuery,
  NotificationRepositoryOverview,
  NotificationState,
  NotificationStateChangeRequest,
} from "@agentic-review/contracts";
import { ReloadOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@umijs/max";
import {
  Alert,
  Button,
  Card,
  Pagination,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useEffect, useRef, useState } from "react";
import {
  NotificationAccess,
  type NotificationAccessState,
  notificationAccessDenied,
  useNotificationAccess,
  useNotificationFailure,
  useNotificationSummary,
} from "@/components/NotificationBell/access";
import { PageHeader } from "@/components/PageHeader";
import { RepositoryScopeUnavailable, useRepositoryScope } from "@/components/RepositoryScope";
import { notificationQueryRoot, notifications } from "@/services/notifications";
import { ReviewControlHttpError } from "@/services/review-control/errors";
import {
  createNotificationStateChange,
  notificationDescription,
  notificationHref,
  notificationLabel,
  notificationUnreadLabel,
} from "./state";
import "./index.css";

const queryOptions = {
  retry: false,
  gcTime: 0,
  refetchInterval: 20_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
} as const;
const workflowLabels = {
  pr_static_build: "Static + build",
  pr_ui: "UI validation",
  issue_triage: "Issue triage",
  issue_validation: "Issue validation",
};

function NotificationSummary({
  repositoryId,
  access,
}: {
  repositoryId?: string;
  access: NotificationAccessState;
}) {
  const query = useNotificationSummary(repositoryId, access);
  return (
    <div className="notifications-summary" role="status">
      <Typography.Text strong>
        {query.data ? notificationUnreadLabel(query.data) : "Unread count unavailable"}
      </Typography.Text>
      <Typography.Text type="secondary">
        For your account · events are immutable records, not current approval recommendations
      </Typography.Text>
    </div>
  );
}
function Coverage({ data }: { data: { coverageStart: string; retainedAfter: string } }) {
  return (
    <Typography.Paragraph type="secondary" className="notifications-coverage">
      Coverage starts {data.coverageStart}. Retained events since {data.retainedAfter}. Older
      activity may not be included.
    </Typography.Paragraph>
  );
}
function RepositoryOverview({ access }: { access: NotificationAccessState }) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: [...notificationQueryRoot, access.session, "overview", page],
    enabled: access.readable,
    queryFn: ({ signal }) => {
      if (!access.principal) throw new Error("A verified operator is required.");
      return notifications.overview({ page, pageSize: 20 }, access.principal, signal);
    },
    ...queryOptions,
  });
  useNotificationFailure(access, query.error);
  return (
    <Card
      title="Repository inboxes"
      extra={
        <Space>
          <Button onClick={() => void access.refreshAccess()}>Refresh access</Button>
          <Button
            icon={<ReloadOutlined />}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh
          </Button>
        </Space>
      }
    >
      <NotificationSummary access={access} />
      <Typography.Paragraph type="secondary">
        Repositories with retained events that you can currently read. Open a repository to inspect
        events and manage your personal read state.
      </Typography.Paragraph>
      {query.isError ? (
        <Alert
          showIcon
          type="error"
          title="Could not load notification overview"
          description="No previous counts are shown. Refresh to try again."
        />
      ) : !query.data ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : (
        <>
          <Table<NotificationRepositoryOverview>
            rowKey="repositoryId"
            pagination={false}
            dataSource={query.data.items}
            columns={[
              {
                title: "Repository",
                key: "repository",
                render: (_, item) => (
                  <Link
                    to={`/notifications?${new URLSearchParams({ repositoryId: item.repositoryId })}`}
                  >
                    {item.fullName}
                  </Link>
                ),
              },
              { title: "Unread", key: "unread", render: (_, item) => item.counts.unread },
              { title: "Read", key: "read", render: (_, item) => item.counts.read },
              { title: "Archived", key: "archived", render: (_, item) => item.counts.archived },
              { title: "Total", key: "total", render: (_, item) => item.counts.total },
            ]}
            locale={{ emptyText: "No retained notifications are available in your repositories." }}
          />
          <Pagination
            current={page}
            pageSize={20}
            total={query.data.total}
            showSizeChanger={false}
            hideOnSinglePage
            onChange={setPage}
          />
          <Coverage data={query.data} />
        </>
      )}
    </Card>
  );
}

function RepositoryInbox({
  repositoryId,
  access,
}: {
  repositoryId: string;
  access: NotificationAccessState;
}) {
  const client = useQueryClient();
  const [filter, setFilter] = useState<NotificationListQuery>({
    state: "all",
    workItemKind: "all",
  });
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<string[]>([]);
  const [intent, setIntent] = useState<NotificationStateChangeRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const live = useRef(true);
  const inFlight = useRef(false);
  const selectionEpoch = useRef(access.session);
  useEffect(() => {
    if (!access.readable || selectionEpoch.current !== access.session) {
      setSelected([]);
      selectionEpoch.current = access.session;
    }
  }, [access.readable, access.session]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const cursor = cursors.at(-1);
  const input = { limit: 20, ...filter, ...(cursor ? { cursor } : {}) };
  const query = useQuery({
    queryKey: [...notificationQueryRoot, access.session, "list", repositoryId, input],
    enabled: access.readable,
    queryFn: ({ signal }) => {
      if (!access.principal) throw new Error("A verified operator is required.");
      return notifications.list(repositoryId, input, access.principal, signal);
    },
    ...queryOptions,
  });
  useNotificationFailure(access, query.error);
  const items = !query.isError ? query.data?.items : undefined;
  const visibleSelection = selected.filter((id) => items?.some((item) => item.event.id === id));
  useEffect(() => {
    if (query.isError) {
      setSelected([]);
    } else if (query.data)
      setSelected((previous) =>
        previous.filter((id) => query.data.items.some((item) => item.event.id === id)),
      );
  }, [query.isError, query.data]);
  const clearSelection = () => {
    setSelected([]);
    setIntent(null);
    setFailure(null);
    setNotice(null);
  };
  const submit = async (request: NotificationStateChangeRequest) => {
    if (!live.current || !access.readable || !access.principal || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    setIntent(request);
    try {
      const receipt = await notifications.change(repositoryId, request, access.principal);
      if (!live.current) return;
      setIntent(null);
      setSelected([]);
      setNotice(
        `${receipt.changes.length} notification${receipt.changes.length === 1 ? "" : "s"} updated for your account${receipt.replayed ? " (original change confirmed)" : ""}.`,
      );
      await client.invalidateQueries({ queryKey: notificationQueryRoot });
    } catch (error) {
      if (!live.current) return;
      if (notificationAccessDenied(error)) {
        clearSelection();
        access.invalidate();
        return;
      }
      if (error instanceof ReviewControlHttpError && error.status >= 400 && error.status < 500) {
        setIntent(null);
        setSelected([]);
        setFailure(
          error.status === 409
            ? "Notification state changed. Refresh and select the current rows before trying again."
            : "The state change was rejected. Refresh before trying again.",
        );
      } else
        setFailure(
          "The response could not be confirmed. Retry the original change to recover its receipt, or discard it and refresh before making a new selection.",
        );
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  };
  const change = (state: NotificationState) => {
    if (!items || intent || busy) return;
    try {
      void submit(
        createNotificationStateChange(items, visibleSelection, state, crypto.randomUUID()),
      );
    } catch {
      setFailure("Select notifications from the current page before applying a change.");
    }
  };
  const changeFilter = (value: NotificationListQuery) => {
    setFilter(value);
    setCursors([undefined]);
    clearSelection();
  };
  return (
    <Card
      title="Your notification inbox"
      extra={
        <Space>
          <Button disabled={busy} onClick={() => void access.refreshAccess()}>
            Refresh access
          </Button>
          <Button
            icon={<ReloadOutlined />}
            disabled={busy || !!intent}
            loading={query.isFetching}
            onClick={() => {
              clearSelection();
              void query.refetch();
            }}
          >
            Refresh
          </Button>
        </Space>
      }
    >
      <NotificationSummary repositoryId={repositoryId} access={access} />
      <Typography.Paragraph type="secondary">
        Opening an event does not mark it as read. Read and archive changes affect only your
        account. Events refresh every 20 seconds while this page is visible.
      </Typography.Paragraph>
      <Space wrap className="notifications-filters">
        <Select
          aria-label="Filter notification state"
          style={{ width: 170 }}
          value={filter.state}
          disabled={busy || !!intent}
          options={[
            { value: "all", label: "All states" },
            { value: "unread", label: "Unread" },
            { value: "read", label: "Read" },
            { value: "archived", label: "Archived" },
          ]}
          onChange={(state) => changeFilter({ ...filter, state })}
        />
        <Select
          aria-label="Filter notification work item kind"
          style={{ width: 180 }}
          value={filter.workItemKind}
          disabled={busy || !!intent}
          options={[
            { value: "all", label: "PRs and issues" },
            { value: "pull_request", label: "Pull requests" },
            { value: "issue", label: "Issues" },
          ]}
          onChange={(workItemKind) => changeFilter({ ...filter, workItemKind })}
        />
      </Space>
      <Space wrap className="notifications-actions">
        <Typography.Text>{visibleSelection.length} selected on this page</Typography.Text>
        <Button
          disabled={busy || !!intent || visibleSelection.length === 0 || query.isError}
          onClick={() => change("read")}
        >
          Mark read
        </Button>
        <Button
          disabled={busy || !!intent || visibleSelection.length === 0 || query.isError}
          onClick={() => change("unread")}
        >
          Mark unread
        </Button>
        <Button
          disabled={busy || !!intent || visibleSelection.length === 0 || query.isError}
          onClick={() => change("archived")}
        >
          Archive
        </Button>
      </Space>
      {notice && <Alert showIcon type="success" title={notice} />}
      {failure && (
        <Alert
          showIcon
          type="error"
          title="Notification state was not confirmed"
          description={failure}
          action={
            intent ? (
              <Space wrap>
                <Button loading={busy} onClick={() => void submit(intent)}>
                  Retry original change
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    clearSelection();
                    void query.refetch();
                  }}
                >
                  Discard and refresh
                </Button>
              </Space>
            ) : undefined
          }
        />
      )}
      {query.isError ? (
        <Alert
          showIcon
          type="error"
          title="Could not load notifications"
          description="Previous events and selection are hidden. Refresh to try again."
        />
      ) : !query.data || !items ? (
        <Skeleton active paragraph={{ rows: 5 }} />
      ) : (
        <>
          <Table<NotificationItem>
            rowKey={(item) => item.event.id}
            dataSource={items}
            pagination={false}
            scroll={{ x: 850 }}
            rowSelection={{
              selectedRowKeys: visibleSelection,
              onChange: (keys) => {
                setSelected(keys.map(String));
                setNotice(null);
              },
              getCheckboxProps: (item) => ({
                disabled: busy || !!intent,
                "aria-label": `Select notification ${item.event.id}`,
              }),
            }}
            columns={[
              {
                title: "Event",
                key: "event",
                render: (_, item) => (
                  <div className="notification-event">
                    <Link
                      aria-label={`Open notification ${item.event.id}`}
                      to={notificationHref(item.event)}
                    >
                      {notificationLabel(item.event)}
                    </Link>
                    <Typography.Text type="secondary">
                      {notificationDescription(item.event)}
                    </Typography.Text>
                    {item.event.kind === "validation" && (
                      <Typography.Text type="secondary">
                        {workflowLabels[item.event.workflowKind]} · {item.event.target}
                      </Typography.Text>
                    )}
                  </div>
                ),
              },
              {
                title: "Work item",
                key: "item",
                width: 120,
                render: (_, item) =>
                  `${item.event.workItemKind === "pull_request" ? "PR" : "Issue"} #${item.event.number}`,
              },
              {
                title: "Your state",
                key: "state",
                width: 110,
                render: (_, item) => (
                  <Tag color={item.state.state === "unread" ? "blue" : undefined}>
                    {item.state.state}
                  </Tag>
                ),
              },
              {
                title: "Occurred",
                key: "time",
                width: 200,
                render: (_, item) => (
                  <time dateTime={item.event.occurredAt}>{item.event.occurredAt}</time>
                ),
              },
            ]}
            locale={{
              emptyText: query.data.nextCursor
                ? "No matching events in this time window. Continue to older events."
                : "No matching notifications in the retained event history.",
            }}
          />
          {query.data.scanLimited && (
            <Typography.Paragraph type="secondary">
              This page covers a bounded window of events. Continue to older events to look further
              back.
            </Typography.Paragraph>
          )}
          <Space wrap className="notifications-pagination">
            <Button
              disabled={busy || !!intent || cursors.length === 1}
              onClick={() => {
                setCursors((previous) => previous.slice(0, -1));
                clearSelection();
              }}
            >
              Newer page
            </Button>
            <Button
              disabled={busy || !!intent || !query.data.nextCursor}
              onClick={() => {
                const next = query.data.nextCursor;
                if (next) {
                  setCursors((previous) => [...previous, next]);
                  clearSelection();
                }
              }}
            >
              Older events
            </Button>
            <Button
              disabled={busy || !!intent || cursors.length === 1}
              onClick={() => {
                setCursors([undefined]);
                clearSelection();
              }}
            >
              Newest events
            </Button>
          </Space>
          <Coverage data={query.data} />
        </>
      )}
    </Card>
  );
}

export default function NotificationsPage() {
  const scope = useRepositoryScope();
  const access = useNotificationAccess(scope.repositoryId);
  return (
    <section className="notifications-page">
      <PageHeader
        eyebrow="Operations"
        title="Notifications"
        description="Follow validation outcomes and publication delivery across your repositories."
      />
      {access.sample ? (
        <NotificationAccess access={access}>{null}</NotificationAccess>
      ) : !scope.ready ? (
        <RepositoryScopeUnavailable />
      ) : (
        <NotificationAccess access={access}>
          {scope.repositoryId ? (
            <RepositoryInbox
              key={access.bindingSession}
              repositoryId={scope.repositoryId}
              access={access}
            />
          ) : (
            <RepositoryOverview key={access.bindingSession} access={access} />
          )}
        </NotificationAccess>
      )}
    </section>
  );
}
