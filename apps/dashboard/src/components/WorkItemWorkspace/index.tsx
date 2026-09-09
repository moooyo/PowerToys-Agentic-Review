import {
  BranchesOutlined,
  GithubOutlined,
  IssuesCloseOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@umijs/max";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Pagination,
  Select,
  Skeleton,
  Space,
  Tag,
  Tooltip,
} from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { CreateReviewRunModal } from "@/components/CreateReviewRun";
import { JobDetailsPanel } from "@/components/JobDetails";
import {
  clearNotificationTargetParameters,
  notificationTargetPath,
  parseNotificationTarget,
} from "@/components/NotificationTarget/targets";
import { OperatorAccessGate, useOperatorAccess } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import { RepositoryScopeUnavailable, useRepositoryScope } from "@/components/RepositoryScope";
import { ReviewRunsDrawer, ReviewRunsPanel } from "@/components/ReviewRuns";
import { reviewPermissionUnavailableReason } from "@/components/ReviewRuns/actions";
import { ErrorNotice } from "@/components/ReviewRuns/common";
import { completedLatestJobProgress, loadLatestWorkItemRun } from "@/components/ReviewRuns/latest";
import {
  loadNotificationRun,
  notificationRunWorkItem,
  type ValidationNotificationTarget,
} from "@/components/ReviewRuns/navigation";
import { reviewControl, type WorkItem, type WorkItemKind } from "@/services/review-control";
import { runs } from "@/services/runs";
import { shortSha } from "@/utils/format";
import "./index.css";

type ProgressTone = "quiet" | "active" | "success" | "warning" | "danger";

interface WorkItemProgress {
  label: string;
  detail: string;
  tone: ProgressTone;
}

const copy = {
  pull_request: {
    title: "Pull requests",
    description: "Review code changes, read findings, and keep track of the revision under review.",
    item: "pull request",
    search: "Search pull requests by title, number, or author",
    inbox: "Review inbox",
    action: "Open results",
    empty: "No pull requests to review",
    emptyDescription:
      "Pull requests appear here after GitHub synchronization. Request a review on GitHub to start.",
    noRun: "This pull request has no review yet",
    noRunDescription:
      "Ask an authorized maintainer to request a review from the configured reviewer on GitHub. The review will appear here once scheduled.",
  },
  issue: {
    title: "Issues",
    description: "Triage reports, inspect suggested labels, and identify what needs a closer look.",
    item: "issue",
    search: "Search issues by title, number, or author",
    inbox: "Triage inbox",
    action: "Open results",
    empty: "No issues to triage",
    emptyDescription:
      "Issues appear here after GitHub synchronization. Assign an issue to the configured reviewer to start triage.",
    noRun: "This issue has not been triaged",
    noRunDescription:
      "Ask an authorized maintainer to assign this issue to the configured reviewer on GitHub. Triage will appear here once scheduled.",
  },
} as const;

const stageLabels: Record<WorkItem["stage"], string> = {
  not_scheduled: "Not scheduled",
  awaiting_admission: "Awaiting admission",
  queued: "Queued",
  preparing: "Preparing",
  reviewing: "Reviewing",
  validating: "Validating",
  waiting_approval: "Finalizing",
  publishing: "Publishing",
  done: "Finished",
};

const authorizationLabels: Record<WorkItem["authorization"], string> = {
  self: "Authorized by the reviewer",
  allowlisted: "Authorized maintainer",
  denied: "Request not authorized",
  pending: "No authorized request",
};

const stateLabels: Record<WorkItem["state"], string> = {
  active: "Open",
  assigned: "Open · assigned",
  closed: "Closed",
  open: "Open",
  unassigned: "Open · unassigned",
};

function progressFor(item: WorkItem): WorkItemProgress {
  const isPullRequest = item.kind === "pull_request";
  if (!item.latestJobId) {
    return {
      label:
        item.authorization === "denied"
          ? "Not authorized"
          : item.trigger === "not_requested"
            ? "Not requested"
            : "Not scheduled",
      detail: item.state === "closed" ? "Closed on GitHub" : "Start from GitHub",
      tone: item.authorization === "denied" ? "warning" : "quiet",
    };
  }
  if (item.latestJobStatus === "failed" || item.latestJobStatus === "dead_letter") {
    return {
      label: "Needs attention",
      detail: item.latestJobStatus === "dead_letter" ? "Retry limit reached" : "Execution failed",
      tone: "danger",
    };
  }
  if (item.latestJobStatus === "cancelled" || item.latestJobStatus === "stale") {
    return {
      label: item.latestJobStatus === "cancelled" ? "Cancelled" : "Superseded",
      detail: "No current result",
      tone: "quiet",
    };
  }
  if (item.freshness === "superseded") {
    return {
      label: "New revision",
      detail:
        item.latestJobStatus === "succeeded"
          ? "Previous result available"
          : "Execution targets an earlier revision",
      tone: "warning",
    };
  }
  if (item.latestJobStatus === "succeeded") {
    return completedLatestJobProgress;
  }
  if (item.latestJobStatus === "cancel_requested") {
    return { label: "Cancelling", detail: "Waiting for execution to stop", tone: "warning" };
  }
  if (item.latestJobStatus === "retry_waiting") {
    return {
      label: item.latestJobAdmission?.state === "pending" ? "Awaiting admission" : "Queued",
      detail: "Waiting for another attempt; retry backoff still applies",
      tone: "warning",
    };
  }
  if (item.latestJobAdmission?.state === "pending")
    return {
      label: "Awaiting admission",
      detail: "Execution saved; waiting to enter the queue",
      tone: "quiet",
    };
  if (item.latestJobStatus === "queued" || item.stage === "queued") {
    return { label: "Queued", detail: "Waiting for an available worker", tone: "quiet" };
  }
  if (item.stage === "waiting_approval") {
    return { label: "Finalizing", detail: "Collecting the result", tone: "active" };
  }
  return {
    label: !isPullRequest && item.stage === "reviewing" ? "Triaging" : stageLabels[item.stage],
    detail: isPullRequest ? "Review in progress" : "Triage in progress",
    tone: "active",
  };
}

function Progress({ item }: { item: WorkItem }) {
  const progress = progressFor(item);
  const colors: Record<ProgressTone, string> = {
    quiet: "default",
    active: "processing",
    success: "success",
    warning: "warning",
    danger: "error",
  };

  return (
    <div className="workspace-progress">
      <Tag color={colors[progress.tone]}>{progress.label}</Tag>
      <span className="workspace-secondary">{progress.detail}</span>
    </div>
  );
}

function updatedLabel(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function RequestContext({ item }: { item: WorkItem }) {
  if (item.trigger === "not_requested") {
    return <span className="workspace-secondary">No request yet</span>;
  }
  return (
    <span className="workspace-secondary">
      {item.trigger === "review_requested"
        ? "Review requested"
        : item.kind === "issue"
          ? "Assigned for triage"
          : "Assigned for review"}{" "}
      by {item.scheduledBy}
    </span>
  );
}

interface WorkItemDetailsProps {
  item: WorkItem | null;
  onClose: () => void;
  onViewRuns: (item: WorkItem) => void;
  onRunValidation: (item: WorkItem) => void;
}

export function WorkItemDetails(props: WorkItemDetailsProps) {
  if (!props.item) return null;
  return (
    <OperatorAccessGate repositoryId={props.item.repositoryId} permission="read">
      <WorkItemDetailsContent
        key={`${props.item.repositoryId}:${props.item.id}`}
        {...props}
        item={props.item}
      />
    </OperatorAccessGate>
  );
}

function WorkItemDetailsContent({
  item,
  onClose,
  onViewRuns,
  onRunValidation,
}: Omit<WorkItemDetailsProps, "item"> & { item: WorkItem }) {
  const content = copy[item.kind];
  const access = useOperatorAccess(item.repositoryId);
  const permissionReason = reviewPermissionUnavailableReason(access);
  const latestRun = useQuery({
    queryKey: ["review-runs", item.repositoryId, item.id, "latest"],
    retry: false,
    enabled: access.can("read"),
    staleTime: Infinity,
    refetchOnMount: "always",
    queryFn: () => loadLatestWorkItemRun(runs, item),
  });
  return (
    <Drawer
      className="workspace-detail"
      destroyOnHidden
      onClose={onClose}
      open={item !== null}
      size="large"
      title={
        access.checking ? (
          "Work item"
        ) : item ? (
          <div className="workspace-detail__identity">
            {item.kind === "pull_request" ? <BranchesOutlined /> : <IssuesCloseOutlined />}
            <span>{item.kind === "pull_request" ? "Pull request" : "Issue"}</span>
            <span className="workspace-detail__number">#{item.number}</span>
          </div>
        ) : (
          ""
        )
      }
      extra={
        !access.checking && item ? (
          <Button href={item.githubUrl} icon={<GithubOutlined />} target="_blank" rel="noreferrer">
            GitHub
          </Button>
        ) : null
      }
    >
      {access.checking && <Skeleton active aria-label="Verifying repository access" />}
      <div hidden={access.checking} inert={access.checking} aria-hidden={access.checking}>
        {item && content ? (
          <>
            <header className="workspace-detail__header">
              <p className="workspace-detail__repository">{item.repository}</p>
              <h2>{item.title}</h2>
              <div className="workspace-detail__context">
                <span className="workspace-secondary">Opened by {item.author}</span>
                <span className="workspace-detail__separator" aria-hidden="true">
                  ·
                </span>
                <RequestContext item={item} />
              </div>
            </header>
            <Space wrap className="workspace-run-actions">
              <Button onClick={() => onViewRuns(item)}>View runs</Button>
              <Tooltip title={permissionReason}>
                <span>
                  <Button
                    type="primary"
                    disabled={!access.can("review")}
                    onClick={() => {
                      if (!access.can("review")) return;
                      onRunValidation(item);
                    }}
                  >
                    Run validation
                  </Button>
                </span>
              </Tooltip>
            </Space>
            {permissionReason && <p className="workspace-secondary">{permissionReason}</p>}
            {latestRun.data === null && item.freshness === "superseded" ? (
              <Alert
                className="workspace-detail__notice"
                title="A newer revision is available"
                description="The execution below targets an earlier revision. Start a new authorized request on GitHub to review the current revision."
                type="warning"
                showIcon
              />
            ) : null}
            {latestRun.isError ? (
              <ErrorNotice
                title="Could not load the latest validation run"
                error={latestRun.error}
                retry={() => void latestRun.refetch()}
              />
            ) : latestRun.isPending ? (
              <Skeleton active aria-label="Loading latest validation run" />
            ) : latestRun.data ? (
              <ReviewRunsPanel
                key={`${item.repositoryId}:${item.id}:${latestRun.data.id}`}
                workItem={item}
                initialRunId={latestRun.data.id}
                embedded
              />
            ) : !access.checking && item.latestJobId ? (
              <JobDetailsPanel
                key={item.latestJobId}
                repositoryId={item.repositoryId}
                jobId={item.latestJobId}
                embedded
              />
            ) : (
              <div className="workspace-unscheduled">
                <Alert
                  title={content.noRun}
                  description={
                    item.state === "closed"
                      ? "This item is closed on GitHub. Reopen it before making a new authorized request."
                      : content.noRunDescription
                  }
                  type="info"
                  showIcon
                />
                <Descriptions
                  column={1}
                  size="small"
                  items={[
                    { key: "state", label: "GitHub state", children: stateLabels[item.state] },
                    {
                      key: "authorization",
                      label: "Authorization",
                      children: authorizationLabels[item.authorization],
                    },
                    ...(item.headSha
                      ? [
                          {
                            key: "revision",
                            label: "Current revision",
                            children: <code>{shortSha(item.headSha)}</code>,
                          },
                        ]
                      : []),
                    {
                      key: "updated",
                      label: "Last synchronized",
                      children: new Date(item.updatedAt).toLocaleString("en-US"),
                    },
                  ]}
                />
                <Button
                  href={item.githubUrl}
                  target="_blank"
                  rel="noreferrer"
                  icon={<GithubOutlined />}
                >
                  Open {content.item} on GitHub
                </Button>
              </div>
            )}
          </>
        ) : null}
      </div>
    </Drawer>
  );
}

export function WorkItemWorkspace({ kind }: { kind: WorkItemKind }) {
  const scope = useRepositoryScope();
  const location = useLocation();
  const navigate = useNavigate();
  const selection = parseNotificationTarget(location.pathname, location.search);
  const target =
    selection.kind === "target" && selection.target.kind === "validation" ? selection.target : null;
  const closeTarget = () =>
    navigate({
      pathname: location.pathname,
      search: clearNotificationTargetParameters(location.search),
      hash: location.hash,
    });
  if (!scope.ready) return <RepositoryScopeUnavailable />;
  return (
    <>
      <ScopedWorkItemWorkspace
        key={`${kind}:${scope.key}:${target ? notificationTargetPath(target) : selection.kind}`}
        kind={kind}
        repositoryId={scope.repositoryId}
        repositoryName={scope.label}
      />
      {selection.kind === "invalid" ? (
        <Drawer open destroyOnHidden title="Validation target unavailable" onClose={closeTarget}>
          <Alert
            type="error"
            showIcon
            title="Invalid validation target"
            description={selection.message}
          />
        </Drawer>
      ) : target ? (
        <NotificationRunTarget
          key={notificationTargetPath(target)}
          target={target}
          onClose={closeTarget}
        />
      ) : null}
    </>
  );
}

export function NotificationRunTarget({
  target,
  onClose,
}: {
  target: ValidationNotificationTarget;
  onClose: () => void;
}) {
  return (
    <OperatorAccessGate repositoryId={target.repositoryId} permission="read">
      <NotificationRunTargetContent target={target} onClose={onClose} />
    </OperatorAccessGate>
  );
}

function NotificationRunTargetContent({
  target,
  onClose,
}: {
  target: ValidationNotificationTarget;
  onClose: () => void;
}) {
  const access = useOperatorAccess(target.repositoryId);
  const query = useQuery({
    queryKey: ["notification-run-target", notificationTargetPath(target), ...access.identityKey],
    enabled: access.can("read"),
    retry: false,
    staleTime: Infinity,
    refetchOnMount: "always",
    queryFn: () => loadNotificationRun(runs, target),
  });
  if (!query.isError && query.isSuccess) {
    return (
      <ReviewRunsDrawer
        workItem={notificationRunWorkItem(query.data)}
        initialRunId={target.reviewRunId}
        initialRequestId={target.requestId}
        initialJobId={target.jobId}
        onClose={onClose}
      />
    );
  }
  return (
    <Drawer open destroyOnHidden title="Validation target" onClose={onClose}>
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <Button
          disabled={access.checking}
          loading={access.checking}
          onClick={() => void access.refresh()}
        >
          Refresh access
        </Button>
        {access.checking || query.isPending ? (
          <Skeleton active aria-label="Loading the exact validation target" />
        ) : (
          <ErrorNotice
            title="Could not load the notification's validation target"
            error={query.error}
            retry={() => void query.refetch()}
          />
        )}
      </Space>
    </Drawer>
  );
}

function ScopedWorkItemWorkspace({
  kind,
  repositoryId,
  repositoryName,
}: {
  kind: WorkItemKind;
  repositoryId?: string;
  repositoryName: string;
}) {
  const content = copy[kind];
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<string>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settledQuery, setSettledQuery] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<WorkItem | null>(null);
  const [runView, setRunView] = useState<{ item: WorkItem; runId?: string } | null>(null);
  const [creatingRunItem, setCreatingRunItem] = useState<WorkItem | null>(null);
  const actionRepositoryId =
    selectedItem?.repositoryId ??
    runView?.item.repositoryId ??
    creatingRunItem?.repositoryId ??
    repositoryId;
  const access = useOperatorAccess(actionRepositoryId);
  const mayRead = access.can("read");
  const requestVersion = useRef(0);
  const queryKey = JSON.stringify({ kind, repositoryId, page, pageSize, search, stage });
  const isUpdating = loading || settledQuery !== queryKey || searchInput.trim() !== search;
  const currentError = isUpdating ? null : error;
  const viewRuns = (item: WorkItem) => {
    setSelectedItem(null);
    setRunView({ item });
  };
  const runValidation = (item: WorkItem) => {
    if (item.repositoryId !== actionRepositoryId || !access.can("review")) return;
    setSelectedItem(null);
    setCreatingRunItem(item);
  };

  useEffect(() => {
    if (searchInput.trim() === search) return undefined;
    const timeout = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [searchInput, search]);

  const loadItems = useCallback(() => {
    if (!mayRead) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    void reviewControl
      .listWorkItems({
        page,
        pageSize,
        search: search || undefined,
        filters: { kind, stage, repositoryId },
      })
      .then((result) => {
        if (version !== requestVersion.current) return;
        const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setItems(result.items);
        setTotal(result.total);
        setSettledQuery(queryKey);
      })
      .catch((reason: unknown) => {
        if (version !== requestVersion.current) return;
        setItems([]);
        setTotal(0);
        setSettledQuery(queryKey);
        setError(reason instanceof Error ? reason.message : "The request could not be completed.");
      })
      .finally(() => {
        if (version === requestVersion.current) setLoading(false);
      });
  }, [kind, page, pageSize, queryKey, repositoryId, search, stage, mayRead]);

  useEffect(() => {
    loadItems();
    return () => {
      requestVersion.current += 1;
    };
  }, [loadItems]);

  return (
    <section
      className="workspace-page"
      aria-labelledby={`workspace-${kind}-title`}
      hidden={access.checking}
      inert={access.checking}
      aria-hidden={access.checking}
    >
      <PageHeader
        eyebrow={repositoryName}
        titleId={`workspace-${kind}-title`}
        title={content.title}
        description={content.description}
        actions={
          <Button
            icon={<ReloadOutlined spin={isUpdating} />}
            onClick={loadItems}
            disabled={isUpdating}
          >
            Refresh
          </Button>
        }
      />

      <Card
        aria-label={content.title}
        className="workspace-panel"
        styles={{ body: { padding: 0 } }}
      >
        <header className="workspace-panel__header">
          <div className="workspace-panel__heading">
            <h2>{content.inbox}</h2>
            <span
              role="status"
              className="workspace-count"
              aria-label={
                currentError
                  ? "Count unavailable"
                  : isUpdating
                    ? "Loading count"
                    : `${total} ${total === 1 ? content.item : content.title.toLowerCase()}${search || stage ? " matched" : " tracked"}`
              }
              aria-live="polite"
            >
              ({currentError ? "—" : isUpdating ? "…" : total})
            </span>
          </div>
          <div className="workspace-toolbar">
            <Input
              allowClear
              aria-label={`Search ${content.title.toLowerCase()}`}
              className="workspace-search"
              maxLength={512}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={content.search}
              prefix={<SearchOutlined />}
              value={searchInput}
            />
            <Select
              allowClear
              aria-label={`Filter ${content.title.toLowerCase()} by latest job progress`}
              className="workspace-stage"
              onChange={(value: string | undefined) => {
                setStage(value);
                setPage(1);
              }}
              options={Object.entries(stageLabels).map(([value, label]) => ({
                value,
                label: value === "reviewing" && kind === "issue" ? "Triaging" : label,
              }))}
              placeholder="Latest job progress"
              value={stage}
            />
          </div>
        </header>

        {currentError ? (
          <Alert
            className="workspace-error"
            title={`Could not load ${content.title.toLowerCase()}`}
            description={currentError}
            type="error"
            showIcon
            action={<Button onClick={loadItems}>Try again</Button>}
          />
        ) : isUpdating ? (
          <div
            className="workspace-loading"
            role="status"
            aria-label={`Loading ${content.title.toLowerCase()}`}
          >
            {[0, 1, 2, 3].map((row) => (
              <div className="workspace-skeleton" key={row} aria-hidden="true">
                <Skeleton active paragraph={{ rows: 1, width: "45%" }} title={{ width: "70%" }} />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <Empty
            className="workspace-empty"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div>
                <strong>{search || stage ? "No matching results" : content.empty}</strong>
                <p>
                  {search || stage
                    ? "Try another search or clear the progress filter."
                    : content.emptyDescription}
                </p>
              </div>
            }
          >
            {search || stage ? (
              <Button
                onClick={() => {
                  setSearchInput("");
                  setSearch("");
                  setStage(undefined);
                  setPage(1);
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </Empty>
        ) : (
          <ul className="workspace-inbox" aria-label={content.inbox}>
            {items.map((item) => (
              <li className="workspace-item" key={item.id}>
                <div className="workspace-item__content">
                  <button
                    className="workspace-item__title"
                    onClick={() => setSelectedItem(item)}
                    type="button"
                  >
                    {item.title}
                  </button>
                  <div className="workspace-item__meta">
                    <a href={item.githubUrl} target="_blank" rel="noreferrer">
                      {item.repository}{" "}
                      <span className="workspace-item__number">#{item.number}</span>
                    </a>
                    <span>by {item.author}</span>
                    {item.state === "closed" ? (
                      <span className="workspace-item__closed">Closed</span>
                    ) : null}
                    {kind === "pull_request" && item.headSha ? (
                      <Tooltip title={`Current revision: ${item.headSha}`}>
                        <code>{shortSha(item.headSha)}</code>
                      </Tooltip>
                    ) : null}
                    <Tooltip
                      title={`Last synchronized: ${new Date(item.updatedAt).toLocaleString("en-US")}`}
                    >
                      <time className="workspace-updated" dateTime={item.updatedAt}>
                        {updatedLabel(item.updatedAt)}
                      </time>
                    </Tooltip>
                  </div>
                </div>
                <div className="workspace-item__aside">
                  <Progress item={item} />
                  <div className="workspace-item__actions">
                    <Button
                      className="workspace-open"
                      type="link"
                      onClick={() => setSelectedItem(item)}
                      aria-label={`Open ${content.item} ${item.number}`}
                    >
                      {item.latestJobStatus === "succeeded" ? content.action : "Details"}
                    </Button>
                    <Button
                      type="link"
                      onClick={() => viewRuns(item)}
                      aria-label={`View runs for ${content.item} ${item.number}`}
                    >
                      View runs
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {!currentError && !isUpdating && total > pageSize ? (
          <footer className="workspace-footer">
            <span aria-live="polite">
              Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
              {search || stage
                ? " matching items"
                : ` ${total === 1 ? content.item : content.title.toLowerCase()}`}
            </span>
            <Pagination
              current={page}
              disabled={isUpdating}
              hideOnSinglePage
              onChange={(nextPage, nextSize) => {
                setPage(nextSize === pageSize ? nextPage : 1);
                setPageSize(nextSize);
              }}
              pageSize={pageSize}
              pageSizeOptions={[20, 50, 100]}
              showSizeChanger
              total={total}
            />
          </footer>
        ) : null}
      </Card>

      <p className="workspace-guidance">
        <GithubOutlined />
        {kind === "pull_request"
          ? "Reviews begin with an authorized review request or assignment on GitHub."
          : "Triage begins when an authorized maintainer assigns an issue on GitHub."}
      </p>
      <WorkItemDetails
        item={selectedItem}
        onClose={() => setSelectedItem(null)}
        onViewRuns={viewRuns}
        onRunValidation={runValidation}
      />
      <ReviewRunsDrawer
        workItem={runView?.item ?? null}
        initialRunId={runView?.runId}
        onClose={() => setRunView(null)}
        onCreateRun={() => {
          if (!runView || runView.item.repositoryId !== actionRepositoryId || !access.can("review"))
            return;
          setCreatingRunItem(runView.item);
          setRunView(null);
        }}
      />
      <CreateReviewRunModal
        workItem={creatingRunItem}
        onClose={() => setCreatingRunItem(null)}
        onCreated={(run) => {
          if (
            !creatingRunItem ||
            run.repositoryId !== creatingRunItem.repositoryId ||
            run.workItemId !== creatingRunItem.id
          )
            return;
          setRunView({ item: creatingRunItem, runId: run.id });
          setCreatingRunItem(null);
          loadItems();
        }}
      />
    </section>
  );
}
