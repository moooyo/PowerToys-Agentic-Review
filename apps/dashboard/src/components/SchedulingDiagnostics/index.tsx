import type { SchedulingDiagnostics as DiagnosticValue } from "@agentic-review/contracts";
import { ReloadOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useModel } from "@umijs/max";
import { Alert, Button, Descriptions, Skeleton, Space, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import {
  type SchedulingReadScope,
  scheduling,
  schedulingMatchesScope,
  schedulingScopeKey,
} from "@/services/scheduling";
import {
  schedulingAccessDenied,
  schedulingDocumentVisible,
  schedulingEffectLabels,
  schedulingPollingInterval,
  schedulingReasonLabels,
  schedulingStageLabel,
} from "./state";

function Time({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {new Date(value).toLocaleString("en-US")}
    </time>
  );
}

function LimitUsage({ usage, limit }: { usage: number; limit: number | null }) {
  return (
    <span>
      {usage} / {limit === null ? "Unlimited" : limit}
    </span>
  );
}

export function SchedulingObservation({ value }: { value: DiagnosticValue }) {
  const repository = value.policy.repository;
  const platform = value.policy.platform;
  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <Space wrap>
        <Tag color={value.stage === "waiting" ? "processing" : "default"}>
          {schedulingStageLabel(value)}
        </Tag>
        <Typography.Text type="secondary">
          Observed <Time value={value.observedAt} />
        </Typography.Text>
      </Space>
      <Descriptions
        size="small"
        column={1}
        items={[
          ...(repository === null
            ? []
            : [
                {
                  key: "repository-policy",
                  label: "Repository policy",
                  children: `Version ${repository.version}${repository.enabled ? "" : " — paused"}`,
                },
                {
                  key: "repository-active",
                  label: "Repository active executions",
                  children: (
                    <LimitUsage
                      usage={repository.usage.activeLeases}
                      limit={repository.limits.maxActiveLeases}
                    />
                  ),
                },
                {
                  key: "repository-queue",
                  label: "Repository admitted queue",
                  children: (
                    <LimitUsage
                      usage={repository.usage.admittedQueuedJobs}
                      limit={repository.limits.maxQueuedJobs}
                    />
                  ),
                },
                {
                  key: "repository-pending",
                  label: "Repository awaiting admission",
                  children: repository.usage.awaitingAdmissionJobs,
                },
                {
                  key: "repository-no-job",
                  label: "Repository awaiting valid configuration",
                  children: repository.usage.awaitingConfigurationRequests,
                },
                ...(repository.overage.activeLeases > 0 || repository.overage.admittedQueuedJobs > 0
                  ? [
                      {
                        key: "repository-overage",
                        label: "Repository overage",
                        children: `${repository.overage.activeLeases} active; ${repository.overage.admittedQueuedJobs} admitted. Existing work is retained.`,
                      },
                    ]
                  : []),
              ]),
          {
            key: "platform-policy",
            label: "Platform policy",
            children: `Version ${platform.visibility === "full" ? platform.configuration.version : platform.version}`,
          },
          ...(platform.visibility === "restricted"
            ? [
                {
                  key: "platform-capacity",
                  label: "Platform quota capacity",
                  children: `Active: ${platform.activeCapacity}; queue: ${platform.queueCapacity}. Global usage details are restricted.`,
                },
              ]
            : [
                {
                  key: "platform-active",
                  label: "Platform active executions",
                  children: (
                    <LimitUsage
                      usage={platform.usage.activeLeases}
                      limit={platform.configuration.limits.maxActiveLeases}
                    />
                  ),
                },
                {
                  key: "platform-queue",
                  label: "Platform admitted queue",
                  children: (
                    <LimitUsage
                      usage={platform.usage.admittedQueuedJobs}
                      limit={platform.configuration.limits.maxQueuedJobs}
                    />
                  ),
                },
                {
                  key: "platform-pending",
                  label: "Platform awaiting admission",
                  children: platform.usage.awaitingAdmissionJobs,
                },
                {
                  key: "platform-no-job",
                  label: "Platform awaiting valid configuration",
                  children: platform.usage.awaitingConfigurationRequests,
                },
                ...(platform.overage.activeLeases > 0 || platform.overage.admittedQueuedJobs > 0
                  ? [
                      {
                        key: "platform-overage",
                        label: "Platform overage",
                        children: `${platform.overage.activeLeases} active; ${platform.overage.admittedQueuedJobs} admitted. Existing work is retained.`,
                      },
                    ]
                  : []),
              ]),
          {
            key: "inspection",
            label: "Inspection coverage",
            children:
              value.workerInspection.state === "complete"
                ? "Complete"
                : value.workerInspection.state === "partial"
                  ? "Partial — some current conditions were not checked"
                  : "Not applicable",
          },
          {
            key: "contact",
            label: "Latest matching worker contact",
            children: value.workerInspection.latestContactAt ? (
              <Time value={value.workerInspection.latestContactAt} />
            ) : (
              "Not recorded"
            ),
          },
        ]}
      />
      <Typography.Text type="secondary">
        Quota capacity describes current limits only. It does not establish worker availability or
        reserve a slot.
      </Typography.Text>
      {value.workerInspection.latestContactAt && (
        <Typography.Text type="secondary">
          Contact time does not establish the age of reported local capacity.
        </Typography.Text>
      )}
      {value.reasons.length > 0 ? (
        <ul style={{ margin: 0, paddingInlineStart: 20 }}>
          {value.reasons.map((reason) => (
            <li key={JSON.stringify(reason)}>
              <Space wrap size="small">
                <Tag>{schedulingEffectLabels[reason.effect]}</Tag>
                <span>{schedulingReasonLabels[reason.code]}</span>
                {reason.code === "retry_backoff" && (
                  <span>
                    Retry eligible after <Time value={reason.until} />; this is not an estimated
                    start.
                  </span>
                )}
                {reason.code === "plan_prerequisite_missing" && reason.requirement && (
                  <Tag>{reason.requirement}</Tag>
                )}
              </Space>
            </li>
          ))}
        </ul>
      ) : value.stage === "waiting" ? (
        <Typography.Text>
          {value.job !== null && "Waiting for a Worker claim. "}
          No blocking cause was observed. This observation does not reserve capacity or predict a
          start time.
        </Typography.Text>
      ) : null}
      {value.reasonsTruncated && (
        <Typography.Text type="secondary">
          Additional reasons were omitted from this observation.
        </Typography.Text>
      )}
      {value.requirements.names.length > 0 && (
        <Space wrap>
          <Typography.Text type="secondary">Required capabilities</Typography.Text>
          {value.requirements.names.map((name) => (
            <Tag key={name}>{name}</Tag>
          ))}
        </Space>
      )}
      {value.requirements.truncated && (
        <Typography.Text type="secondary">
          Some requirement names could not be included.
        </Typography.Text>
      )}
      <Typography.Text type="secondary">
        Current scheduling observations are separate from frozen plan readiness. Current request
        requirements do not necessarily prevent an already queued execution from starting.
      </Typography.Text>
    </Space>
  );
}

function SchedulingSession({
  scope,
  session,
  refreshAccess,
  platformAdministrator,
}: {
  scope: SchedulingReadScope;
  session: string;
  refreshAccess: () => Promise<void>;
  platformAdministrator: boolean;
}) {
  const client = useQueryClient();
  const [accessLost, setAccessLost] = useState(false);
  const key = JSON.stringify([...schedulingScopeKey(scope), scheduling.mode, session]);
  const queryKey = useMemo(() => JSON.parse(key) as readonly string[], [key]);
  useEffect(() => {
    const discard = () => {
      void client.cancelQueries({ queryKey, exact: true });
      client.removeQueries({ queryKey, exact: true });
    };
    if (accessLost) discard();
    return discard;
  }, [client, queryKey, accessLost]);
  const query = useQuery({
    queryKey,
    enabled: !accessLost,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      signal.throwIfAborted();
      const value = await scheduling.get(scope, signal);
      signal.throwIfAborted();
      if (
        !schedulingMatchesScope(value, scope) ||
        (value.policy.platform.visibility === "full" && !platformAdministrator)
      )
        throw new Error("The scheduling observation belongs to another scope.");
      return value;
    },
    refetchInterval: (current) =>
      schedulingPollingInterval({
        visible: schedulingDocumentVisible() && !accessLost,
        connected: scheduling.mode === "connected",
        error: current.state.status === "error",
        stage: current.state.data?.stage,
      }),
  });
  useEffect(() => {
    if (schedulingAccessDenied(query.error)) setAccessLost(true);
  }, [query.error]);
  const unavailable = accessLost || schedulingAccessDenied(query.error);
  if (unavailable)
    return (
      <Alert
        showIcon
        type="info"
        title="Scheduling access is unavailable"
        description="Verify access before loading this observation again."
        action={<Button onClick={() => void refreshAccess()}>Refresh access</Button>}
      />
    );
  const value =
    !query.isError &&
    query.data &&
    schedulingMatchesScope(query.data, scope) &&
    (query.data.policy.platform.visibility !== "full" || platformAdministrator)
      ? query.data
      : null;
  return (
    <section aria-label="Current scheduling" style={{ width: "100%" }}>
      <Space orientation="vertical" size="small" style={{ width: "100%" }}>
        <Space wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Current scheduling
          </Typography.Title>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh scheduling
          </Button>
        </Space>
        {query.isError || (query.isSuccess && !value) ? (
          <Alert
            showIcon
            type="warning"
            title="Current scheduling could not be loaded"
            description="Refresh to try again. No previous observation is shown."
          />
        ) : query.isPending ? (
          <Skeleton active paragraph={{ rows: 2 }} />
        ) : value ? (
          <SchedulingObservation value={value} />
        ) : null}
        <Typography.Text type="secondary">
          Visible waiting and active observations refresh every 5 seconds.
        </Typography.Text>
      </Space>
    </section>
  );
}

export function SchedulingDiagnostics({
  scope,
  visible = true,
}: {
  scope: SchedulingReadScope;
  visible?: boolean;
}) {
  const access = useOperatorAccess(scope.kind === "platform_job" ? undefined : scope.repositoryId);
  const { initialState } = useModel("@@initialState");
  const [documentVisible, setDocumentVisible] = useState(schedulingDocumentVisible);
  useEffect(() => {
    const changed = () => setDocumentVisible(schedulingDocumentVisible());
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", changed);
    return () => {
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", changed);
    };
  }, []);
  if (!visible || !documentVisible) return null;
  if (scheduling.mode === "sample")
    return (
      <Alert
        showIcon
        type="info"
        title="Live scheduling is unavailable in Sample mode"
        description="Sample data does not contain real scheduling observations. Connect to a server to inspect current waiting reasons."
      />
    );
  if (access.pending || access.checking) return <Skeleton active paragraph={{ rows: 2 }} />;
  const allowed =
    access.ready &&
    !access.error &&
    access.principal &&
    (scope.kind === "platform_job" ? access.platformAdministrator : access.can("read"));
  if (!allowed)
    return (
      <Alert
        showIcon
        type="info"
        title="Scheduling access is unavailable"
        description={
          scope.kind === "platform_job"
            ? "Platform administrator access is required for this job observation."
            : "Repository read access is required for this observation."
        }
        action={<Button onClick={() => void access.refresh()}>Refresh access</Button>}
      />
    );
  const session = JSON.stringify([
    initialState?.authenticationEpoch ?? 0,
    access.identityKey,
    access.principal,
    access.context?.platformAdministrator,
    access.context?.repository,
  ]);
  return (
    <SchedulingSession
      key={JSON.stringify([...schedulingScopeKey(scope), scheduling.mode, session])}
      scope={scope}
      session={session}
      refreshAccess={access.refresh}
      platformAdministrator={access.platformAdministrator}
    />
  );
}
