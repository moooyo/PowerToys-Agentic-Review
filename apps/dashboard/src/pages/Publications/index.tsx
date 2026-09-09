import type {
  PublicationControlAction,
  PublicationControlRequest,
  PublicationDetail,
  PublicationStatus,
  PublicationSummary,
} from "@agentic-review/contracts";
import {
  getPublicationAttemptIssues,
  getPublicationRemoteReceiptIssues,
} from "@agentic-review/contracts";
import { ReloadOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@umijs/max";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Modal,
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
  clearNotificationTargetParameters,
  notificationTargetPath,
  parseNotificationTarget,
} from "@/components/NotificationTarget/targets";
import type { useOperatorAccess } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import {
  PublicationAccess,
  publicationAccessDenied,
  publicationError,
  usePublicationReadGuard,
} from "@/components/PublicationPreview/access";
import { PublicationDocument } from "@/components/PublicationPreview/Document";
import {
  publicationActions,
  publicationControl,
  publicationDeliveryLimitations,
} from "@/components/PublicationPreview/state";
import { RepositoryScopeUnavailable, useRepositoryScope } from "@/components/RepositoryScope";
import { publicationQueryRoot, publications } from "@/services/publications";
import "./index.css";

const statuses: PublicationStatus[] = [
  "pending",
  "delivering",
  "published",
  "failed",
  "blocked",
  "unknown",
  "cancelled",
];
const labels: Record<PublicationControlAction, string> = {
  cancel: "Cancel publication",
  retry: "Retry delivery",
  reconcile: "Check GitHub (GET only)",
};
const actionDescriptions: Record<PublicationControlAction, string> = {
  cancel:
    "Cancel this confirmed publication before sending. Its frozen content and attempt history are retained.",
  retry:
    "Request another delivery attempt for this exact frozen body. The server rechecks current permission, policy, source and evidence before sending.",
  reconcile:
    "Read GitHub to find an exact match for this target, marker, body and publisher. This action uses GET requests only and cannot resend the publication. No match or an incomplete scan remains uncertain.",
};
function Status({ status }: { status: PublicationStatus }) {
  return (
    <Tag
      color={
        status === "published"
          ? "success"
          : status === "unknown"
            ? "warning"
            : ["failed", "blocked"].includes(status)
              ? "error"
              : "default"
      }
    >
      {status}
    </Tag>
  );
}
function OutboxDetail({
  repositoryId,
  publicationId,
  session,
  access,
  onClose,
}: {
  repositoryId: string;
  publicationId: string;
  session: string;
  access: ReturnType<typeof useOperatorAccess>;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [page, setPage] = useState(1),
    [failure, setFailure] = useState<unknown>(null),
    [notice, setNotice] = useState<string | null>(null),
    [saving, setSaving] = useState(false);
  const [intent, setIntent] = useState<{
    action: PublicationControlAction;
    request: PublicationControlRequest;
    detail: PublicationDetail;
  } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const scope = { repositoryId, publicationId };
  const detailKey = [...publicationQueryRoot, session, "outbox", "detail", publicationId];
  const attemptsKey = [...publicationQueryRoot, session, "outbox", "attempts", publicationId];
  const read = usePublicationReadGuard([detailKey, attemptsKey]);
  const query = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) => read.guard.read(() => publications.get(scope, signal)),
    enabled: !read.denied && !access.checking,
    retry: false,
    refetchInterval: read.denied || access.checking ? false : 5_000,
    gcTime: 0,
  });
  const attempts = useQuery({
    queryKey: [...attemptsKey, page],
    queryFn: ({ signal }) =>
      read.guard.read(() => publications.attempts({ ...scope, page, pageSize: 20 }, signal)),
    enabled: !read.denied && !access.checking,
    retry: false,
    refetchInterval: read.denied || access.checking ? false : 5_000,
    gcTime: 0,
  });
  const denied =
    read.denied ||
    publicationAccessDenied(query.error) ||
    publicationAccessDenied(attempts.error) ||
    publicationAccessDenied(failure);
  const detail = !query.isError && !denied && !access.checking ? query.data : undefined;
  const historyMismatch =
    !!detail &&
    !!attempts.data &&
    attempts.data.items.some(
      (entry) =>
        getPublicationAttemptIssues(entry, publicationId, detail.intent.publisherGitHubUserId)
          .length > 0 ||
        (entry.remoteReceipt !== null &&
          getPublicationRemoteReceiptIssues(
            entry.remoteReceipt,
            detail.intent.target,
            detail.intent.publisherGitHubUserId,
            detail.intent.payload,
          ).length > 0),
    );
  const currentActionAllowed =
    intent !== null &&
    detail !== undefined &&
    publicationActions(detail).includes(intent.action) &&
    intent.request.expectedVersion === detail.delivery.version;
  const begin = (action: PublicationControlAction) => {
    if (
      !detail ||
      !access.can("configure") ||
      inFlight.current ||
      !publicationActions(detail).includes(action)
    )
      return;
    setFailure(null);
    setNotice(null);
    setIntent({
      action,
      request: publicationControl(detail, action, crypto.randomUUID()),
      detail: structuredClone(detail),
    });
  };
  const submit = async () => {
    if (
      !intent ||
      read.guard.snapshot() ||
      !access.can("configure") ||
      !currentActionAllowed ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const result = await publications.control(scope, intent.action, intent.request);
      if (!mounted.current || read.guard.snapshot()) return;
      if (
        result.change.actor.issuer !== access.principal?.issuer ||
        result.change.actor.subject !== access.principal?.subject
      )
        throw new Error("The publication control receipt does not match this operator.");
      setNotice(
        `${result.replayed ? "Original action recovered" : "Action recorded"}: ${labels[intent.action]}. Current delivery state is shown below.`,
      );
      setIntent(null);
      await client.invalidateQueries({ queryKey: [...publicationQueryRoot, session, "outbox"] });
    } catch (error) {
      if (!mounted.current) return;
      read.guard.deny(error);
      setFailure(error);
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return (
    <Drawer
      open
      title="Publication details"
      size={940}
      onClose={onClose}
      closable={!saving}
      keyboard={!saving}
      mask={{ closable: !saving }}
      extra={
        <Button disabled={saving} onClick={() => void access.refresh()}>
          Refresh access
        </Button>
      }
    >
      {access.checking ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : denied ? (
        <Alert
          showIcon
          type="info"
          title="Publication access is unavailable"
          description="The previous publication content has been cleared."
        />
      ) : query.isError ? (
        <Alert
          showIcon
          type="error"
          title="Could not load publication"
          description={publicationError(query.error)}
          action={<Button onClick={() => void query.refetch()}>Try again</Button>}
        />
      ) : !detail ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : (
        <Space orientation="vertical" size="large" className="publication-stack">
          {notice && <Alert showIcon type="success" title={notice} />}
          <Space wrap>
            <Status status={detail.delivery.status} />
            <Typography.Text type="secondary">
              Delivery version {detail.delivery.version} · Updated {detail.delivery.updatedAt}
            </Typography.Text>
          </Space>
          <Descriptions
            column={1}
            size="small"
            items={[
              {
                key: "id",
                label: "Publication ID",
                children: <code>{detail.intent.publicationId}</code>,
              },
              {
                key: "actor",
                label: "Confirmed by",
                children: `${detail.intent.actor.subject} · ${detail.intent.actor.issuer}`,
              },
              { key: "created", label: "Confirmed at", children: detail.intent.createdAt },
              {
                key: "attempts",
                label: "Delivery and reconciliation attempts",
                children: detail.delivery.attemptCount,
              },
              {
                key: "failure",
                label: "Current result",
                children: detail.delivery.failure
                  ? `${detail.delivery.failure.code}: ${detail.delivery.failure.message}`
                  : "No failure recorded",
              },
              {
                key: "remote",
                label: "Verified remote publication",
                children: detail.delivery.remoteReceipt ? (
                  <a href={detail.delivery.remoteReceipt.htmlUrl} target="_blank" rel="noreferrer">
                    Open the recorded GitHub publication
                  </a>
                ) : (
                  "No verified remote receipt"
                ),
              },
            ]}
          />
          {detail.delivery.status === "unknown" && (
            <Alert
              showIcon
              type="warning"
              title="Delivery is uncertain"
              description="Sending may have begun. This publication cannot be retried or cancelled. Check GitHub using read-only reconciliation; an absent match never authorizes another send."
            />
          )}
          <Space wrap>
            {publicationActions(detail).map((action) => (
              <Button
                key={action}
                danger={action === "cancel"}
                disabled={!access.can("configure") || saving}
                onClick={() => begin(action)}
              >
                {labels[action]}
              </Button>
            ))}
          </Space>
          {!access.allows("configure") && (
            <Typography.Text type="secondary">
              Maintainer access or higher is required to cancel, retry, or reconcile publication.
            </Typography.Text>
          )}
          <PublicationDocument
            target={detail.intent.target}
            payload={detail.intent.payload}
            binding={detail.intent.binding}
            publisherGitHubUserId={detail.intent.publisherGitHubUserId}
            payloadSha256={detail.intent.payloadSha256}
          />
          <Typography.Paragraph type="secondary">
            {publicationDeliveryLimitations}
          </Typography.Paragraph>
          <Card size="small" title="Append-only delivery and reconciliation history">
            {attempts.isError || historyMismatch ? (
              <Alert
                showIcon
                type="error"
                title="Could not load publication history"
                description={
                  historyMismatch
                    ? "The history does not match this publication target and publisher."
                    : publicationError(attempts.error)
                }
              />
            ) : !attempts.data ? (
              <Skeleton active />
            ) : (
              <>
                <Table
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={attempts.data.items}
                  columns={[
                    { title: "Attempt", dataIndex: "attemptNumber" },
                    { title: "Kind", dataIndex: "kind" },
                    { title: "Phase", dataIndex: "phase" },
                    {
                      title: "Result",
                      render: (_, entry) =>
                        entry.phase === "outcome" ? entry.outcome : "No outcome recorded",
                    },
                    {
                      title: "Details",
                      render: (_, entry) =>
                        entry.failure ? (
                          `${entry.failure.code}: ${entry.failure.message}`
                        ) : entry.remoteReceipt ? (
                          <a href={entry.remoteReceipt.htmlUrl} target="_blank" rel="noreferrer">
                            Verified GitHub receipt
                          </a>
                        ) : (
                          "No remote receipt"
                        ),
                    },
                    { title: "Recorded at", dataIndex: "createdAt" },
                  ]}
                  locale={{
                    emptyText: "No delivery or reconciliation observations have been recorded.",
                  }}
                />
                <Pagination
                  current={page}
                  pageSize={20}
                  total={attempts.data.total}
                  showSizeChanger={false}
                  hideOnSinglePage
                  onChange={setPage}
                />
              </>
            )}
          </Card>
        </Space>
      )}
      {intent && !denied && !access.checking && (
        <Modal
          open
          title={labels[intent.action]}
          okText={failure ? "Retry original action" : labels[intent.action]}
          onOk={() => void submit()}
          onCancel={() => {
            if (!saving) {
              setIntent(null);
              setFailure(null);
            }
          }}
          confirmLoading={saving}
          okButtonProps={{
            disabled: !access.can("configure") || !currentActionAllowed,
            danger: intent.action === "cancel",
          }}
          cancelButtonProps={{ disabled: saving }}
          closable={!saving}
          keyboard={!saving}
          mask={{ closable: !saving }}
        >
          <Typography.Paragraph>{actionDescriptions[intent.action]}</Typography.Paragraph>
          {!currentActionAllowed && (
            <Alert
              showIcon
              type="warning"
              title="Delivery state changed"
              description="Close this dialog and review the current state before choosing an action. Unknown delivery permits only read-only reconciliation."
            />
          )}
          <Descriptions
            column={1}
            size="small"
            items={[
              { key: "id", label: "Publication", children: <code>{publicationId}</code> },
              {
                key: "version",
                label: "Expected delivery version",
                children: intent.request.expectedVersion,
              },
              {
                key: "body",
                label: "Frozen payload digest",
                children: <code>{intent.request.expectedPayloadSha256}</code>,
              },
            ]}
          />
          {!!failure && (
            <Alert
              showIcon
              type="error"
              title="Publication action failed"
              description={`${publicationError(failure)} The original request identity is retained. Close this dialog to discard it and review current state.`}
            />
          )}
        </Modal>
      )}
    </Drawer>
  );
}
function Outbox({
  repositoryId,
  session,
  access,
  selectedPublicationId,
  onSelectPublication,
}: {
  repositoryId: string;
  session: string;
  access: ReturnType<typeof useOperatorAccess>;
  selectedPublicationId?: string;
  onSelectPublication: (publicationId: string | null) => void;
}) {
  const [page, setPage] = useState(1),
    [status, setStatus] = useState<PublicationStatus>();
  const listKey = [...publicationQueryRoot, session, "outbox", "list", repositoryId];
  const read = usePublicationReadGuard([listKey]);
  const query = useQuery({
    queryKey: [...listKey, page, status],
    queryFn: ({ signal }) =>
      read.guard.read(() =>
        publications.list(
          { repositoryId, page, pageSize: 20, ...(status ? { status } : {}) },
          signal,
        ),
      ),
    enabled: !read.denied && !access.checking,
    retry: false,
    refetchInterval: read.denied || access.checking ? false : 5_000,
    gcTime: 0,
  });
  return (
    <>
      <Card
        title="Repository outbox"
        extra={
          <Space>
            <Button onClick={() => void access.refresh()}>Refresh access</Button>
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
        <Typography.Paragraph type="secondary">
          Confirmed immutable publications for this repository only. Current delivery state
          refreshes every 5 seconds.
        </Typography.Paragraph>
        <Select
          aria-label="Filter publication status"
          placeholder="All delivery states"
          allowClear
          style={{ width: 220, marginBottom: 16 }}
          options={statuses.map((value) => ({ value, label: value }))}
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
            onSelectPublication(null);
          }}
        />
        {read.denied ? (
          <Alert
            showIcon
            type="info"
            title="Publication access is unavailable"
            description="The previous outbox content has been cleared. Refresh access before loading publications."
          />
        ) : query.isError ? (
          <Alert
            showIcon
            type="error"
            title="Could not load repository publications"
            description={publicationError(query.error)}
          />
        ) : !query.data ? (
          <Skeleton active paragraph={{ rows: 5 }} />
        ) : (
          <>
            <Table<PublicationSummary>
              rowKey="publicationId"
              dataSource={query.data.items}
              pagination={false}
              scroll={{ x: 800 }}
              columns={[
                {
                  key: "target",
                  title: "Target",
                  render: (_, entry) =>
                    `${entry.target.kind === "pull_request" ? "PR" : "Issue"} #${entry.target.number} · ${entry.target.fullName}`,
                },
                {
                  key: "state",
                  title: "State",
                  render: (_, entry) => <Status status={entry.delivery.status} />,
                },
                {
                  key: "decision",
                  title: "Decision",
                  render: (_, entry) => <code>{entry.selectedDecisionId}</code>,
                },
                {
                  key: "attempts",
                  title: "Attempts",
                  render: (_, entry) => entry.delivery.attemptCount,
                },
                {
                  key: "updated",
                  title: "Updated",
                  render: (_, entry) => entry.delivery.updatedAt,
                },
                {
                  key: "details",
                  title: "Details",
                  render: (_, entry) => (
                    <Button
                      aria-label={`Inspect publication ${entry.publicationId}`}
                      onClick={() => onSelectPublication(entry.publicationId)}
                    >
                      Inspect
                    </Button>
                  ),
                },
              ]}
              locale={{ emptyText: "No publications have been confirmed for this repository." }}
            />
            <Pagination
              current={page}
              pageSize={20}
              total={query.data.total}
              showSizeChanger={false}
              hideOnSinglePage
              onChange={(value) => {
                setPage(value);
                onSelectPublication(null);
              }}
            />
          </>
        )}
      </Card>
      {selectedPublicationId && !query.isError && !read.denied && (
        <OutboxDetail
          key={selectedPublicationId}
          repositoryId={repositoryId}
          publicationId={selectedPublicationId}
          session={session}
          access={access}
          onClose={() => onSelectPublication(null)}
        />
      )}
    </>
  );
}
export default function PublicationsPage() {
  const scope = useRepositoryScope();
  const location = useLocation();
  const navigate = useNavigate();
  const target = parseNotificationTarget(location.pathname, location.search);
  const validSelection =
    target.kind === "target" &&
    target.target.kind === "publication" &&
    target.target.repositoryId === scope.repositoryId
      ? target.target.publicationId
      : undefined;
  const selectPublication = (publicationId: string | null) => {
    if (publicationId !== null && scope.repositoryId)
      navigate(
        notificationTargetPath({
          kind: "publication",
          repositoryId: scope.repositoryId,
          publicationId,
        }),
      );
    else
      navigate({
        pathname: location.pathname,
        search: clearNotificationTargetParameters(location.search),
      });
  };
  return (
    <section className="publications-page">
      <PageHeader
        eyebrow="Delivery"
        title="Publications"
        description="Review confirmed publication content, delivery history and conservative recovery."
      />
      {target.kind === "invalid" ? (
        <Alert
          showIcon
          type="error"
          title="Invalid publication target"
          description={target.message}
          action={<Button onClick={() => selectPublication(null)}>Clear target</Button>}
        />
      ) : !scope.repositoryId ? (
        <Alert
          showIcon
          type="info"
          title="Select a repository"
          description="Choose one repository in the repository selector to inspect its publication outbox. There is no cross-repository outbox view."
        />
      ) : !scope.ready ? (
        <RepositoryScopeUnavailable />
      ) : (
        <PublicationAccess repositoryId={scope.repositoryId}>
          {(session, access) => (
            <Outbox
              key={session}
              repositoryId={scope.repositoryId as string}
              session={session}
              access={access}
              selectedPublicationId={validSelection}
              onSelectPublication={selectPublication}
            />
          )}
        </PublicationAccess>
      )}
    </section>
  );
}
