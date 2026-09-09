import type {
  PlatformSchedulingStatus,
  SchedulingConfiguration,
  SchedulingConfigurationAuditSummary,
  SchedulingLimits,
  SchedulingOverage,
  SchedulingUsage,
} from "@agentic-review/contracts";
import { ReloadOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useModel } from "@umijs/max";
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Drawer,
  Form,
  Pagination,
  Row,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from "antd";
import { type ReactNode, useEffect, useState } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { schedulingPolicy, schedulingPolicyQueryRoot } from "@/services/scheduling-policy";
import { isConfigurationConflict } from "../../pages/Repositories/form";
import {
  buildSchedulingLimits,
  type SchedulingLimitValues,
  schedulingLimitsLabel,
  schedulingLimitValues,
} from "./form";
import { SchedulingLimitFields } from "./LimitFields";

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The scheduling request could not be completed. Try again.";
}
function Time({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {new Date(value).toLocaleString("en-US")}
    </time>
  );
}

export function SchedulingUsageSummary({
  usage,
  overage,
}: {
  usage: SchedulingUsage;
  overage?: SchedulingOverage;
}) {
  return (
    <>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Statistic title="Active leases" value={usage.activeLeases} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="Admitted queued jobs" value={usage.admittedQueuedJobs} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="Awaiting admission" value={usage.awaitingAdmissionJobs} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic
            title="Awaiting valid configuration"
            value={usage.awaitingConfigurationRequests}
          />
        </Col>
      </Row>
      <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
        Active leases count leased and running attempts. The admitted queue includes jobs waiting to
        start or retry. Jobs awaiting admission have a saved Job ID. Requests awaiting valid
        configuration have no job yet.
      </Typography.Paragraph>
      {overage && (overage.activeLeases > 0 || overage.admittedQueuedJobs > 0) && (
        <Alert
          showIcon
          type="warning"
          title="Usage exceeds a configured limit"
          description={`${overage.activeLeases.toLocaleString("en-US")} active leases and ${overage.admittedQueuedJobs.toLocaleString("en-US")} admitted queued jobs above their limits. Existing work is retained; new grants or admission wait for capacity.`}
        />
      )}
    </>
  );
}

function Limits({ limits }: { limits: SchedulingLimits }) {
  return (
    <Descriptions
      size="small"
      column={2}
      items={[
        {
          key: "active",
          label: "Active lease limit",
          children: schedulingLimitsLabel(limits.maxActiveLeases),
        },
        {
          key: "queue",
          label: "Admitted queue limit",
          children: schedulingLimitsLabel(limits.maxQueuedJobs),
        },
      ]}
    />
  );
}

function useClearSchedulingSession(session: string) {
  const client = useQueryClient();
  useEffect(
    () => () => {
      const queryKey = [...schedulingPolicyQueryRoot, session];
      void client.cancelQueries({ queryKey });
      client.removeQueries({ queryKey });
    },
    [client, session],
  );
}

function SchedulingAccess({
  repositoryId,
  children,
}: {
  repositoryId?: string;
  children: (session: string, checking: boolean) => ReactNode;
}) {
  const access = useOperatorAccess(repositoryId);
  const { initialState } = useModel("@@initialState");
  const allowed =
    access.ready &&
    !access.error &&
    (repositoryId ? access.allows("read") : access.platformAdministrator);
  const session = JSON.stringify([
    schedulingPolicy.mode,
    repositoryId ?? "platform",
    access.identityKey,
    initialState?.authenticationEpoch ?? 0,
    access.context?.platformAdministrator,
    access.context?.repository,
  ]);
  if (access.pending) return <Skeleton active paragraph={{ rows: 3 }} />;
  if (!allowed)
    return (
      <Alert
        showIcon
        type="info"
        title="Scheduling information is unavailable"
        description={
          repositoryId
            ? "Verify repository read access to inspect current scheduling."
            : "Platform administrator access is required to inspect global scheduling policy and history."
        }
        action={<Button onClick={() => void access.refresh()}>Refresh access</Button>}
      />
    );
  return <div key={session}>{children(session, access.checking)}</div>;
}

function RepositorySchedulingSession({
  repositoryId,
  session,
  checking,
}: {
  repositoryId: string;
  session: string;
  checking: boolean;
}) {
  useClearSchedulingSession(session);
  const access = useOperatorAccess(repositoryId);
  const query = useQuery({
    queryKey: [...schedulingPolicyQueryRoot, session, "repository", repositoryId],
    queryFn: async ({ signal }) => {
      const result = await schedulingPolicy.repository(repositoryId, signal);
      if (!access.platformAdministrator && result.platform.visibility !== "restricted")
        throw new Error("Global scheduling details exceeded the current operator's scope.");
      return result;
    },
    enabled: !checking,
    refetchInterval: 5_000,
    retry: false,
    gcTime: 0,
  });
  const value = !checking && !query.isError ? query.data : undefined;
  return (
    <Card
      size="small"
      title="Current scheduling"
      extra={
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={query.isFetching || checking}
          disabled={checking}
          onClick={() => void query.refetch()}
        >
          Refresh
        </Button>
      }
    >
      {query.isError ? (
        <Alert
          showIcon
          type="error"
          title="Could not load current scheduling"
          description={errorMessage(query.error)}
        />
      ) : !value ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : (
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Space wrap>
            <Tag color={value.enabled ? "success" : "warning"}>
              {value.enabled ? "Repository enabled" : "Repository paused"}
            </Tag>
            <Typography.Text type="secondary">
              Observed <Time value={value.observedAt} /> · Updates every 5 seconds
            </Typography.Text>
          </Space>
          <Limits limits={value.limits} />
          <SchedulingUsageSummary usage={value.usage} overage={value.overage} />
          {value.platform.visibility === "restricted" ? (
            <Alert
              showIcon
              type="info"
              title="Global capacity details are restricted"
              description={
                <>
                  Global active capacity:{" "}
                  {value.platform.activeCapacity === "limited"
                    ? "at its limit"
                    : "quota headroom available"}
                  . Global queue capacity:{" "}
                  {value.platform.queueCapacity === "limited"
                    ? "at its limit"
                    : "quota headroom available"}
                  . Global counts and limits require platform administrator access. Restricted
                  details do not mean unlimited capacity.
                </>
              }
            />
          ) : (
            <div>
              <Typography.Title level={5}>Global limits</Typography.Title>
              <Limits limits={value.platform.configuration.limits} />
            </div>
          )}
          <Typography.Text type="secondary">
            Unlimited removes only this scope's additional limit. Global limits and Worker
            constraints still apply. Capacity observations do not reserve a slot or estimate a start
            time.
          </Typography.Text>
        </Space>
      )}
    </Card>
  );
}

export function RepositorySchedulingPolicy({ repositoryId }: { repositoryId: string }) {
  return (
    <SchedulingAccess repositoryId={repositoryId}>
      {(session, checking) => (
        <RepositorySchedulingSession
          key={session}
          repositoryId={repositoryId}
          session={session}
          checking={checking}
        />
      )}
    </SchedulingAccess>
  );
}

function SchedulingEvent({
  summary,
  session,
  onClose,
}: {
  summary: SchedulingConfigurationAuditSummary;
  session: string;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: [...schedulingPolicyQueryRoot, session, "event", summary.id],
    queryFn: async ({ signal }) => {
      const event = await schedulingPolicy.event(summary.id, signal);
      if (
        event.version !== summary.version ||
        event.previousVersion !== summary.previousVersion ||
        event.createdAt !== summary.createdAt ||
        event.actor.issuer !== summary.actor.issuer ||
        event.actor.subject !== summary.actor.subject
      )
        throw new Error("The scheduling event does not match the selected audit summary.");
      return event;
    },
    retry: false,
    gcTime: 0,
  });
  const event = !query.isError ? query.data : undefined;
  return (
    <Drawer open size={680} title="Scheduling configuration event" onClose={onClose}>
      {query.isError ? (
        <Alert
          showIcon
          type="error"
          title="Could not load scheduling event"
          description={errorMessage(query.error)}
          action={<Button onClick={() => void query.refetch()}>Try again</Button>}
        />
      ) : !event ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : (
        <>
          <Descriptions
            column={1}
            items={[
              { key: "time", label: "Recorded at", children: <Time value={event.createdAt} /> },
              {
                key: "actor",
                label: "Actor",
                children: (
                  <span>
                    {event.actor.subject}
                    <br />
                    <Typography.Text type="secondary">{event.actor.issuer}</Typography.Text>
                  </span>
                ),
              },
              {
                key: "revision",
                label: "Version",
                children: `${event.previousVersion} → ${event.version}`,
              },
              { key: "policy", label: "Service policy", children: event.snapshot.policyId },
            ]}
          />
          <Divider />
          <Typography.Title level={5}>Previous recorded limits</Typography.Title>
          <Limits limits={event.previousSnapshot.limits} />
          <Typography.Title level={5}>Saved limits</Typography.Title>
          <Limits limits={event.snapshot.limits} />
          <Typography.Paragraph type="secondary">
            These are immutable configuration snapshots from this operation. Current usage is not
            historical usage.
          </Typography.Paragraph>
        </>
      )}
    </Drawer>
  );
}

function SchedulingActivity({ session, checking }: { session: string; checking: boolean }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<SchedulingConfigurationAuditSummary | null>(null);
  const query = useQuery({
    queryKey: [...schedulingPolicyQueryRoot, session, "activity", page],
    queryFn: ({ signal }) => schedulingPolicy.activity({ page, pageSize: 20 }, signal),
    enabled: !checking,
    retry: false,
    gcTime: 0,
  });
  const result = !query.isError && !checking ? query.data : undefined;
  return (
    <Card
      size="small"
      title="Scheduling configuration activity"
      extra={
        <Button
          size="small"
          icon={<ReloadOutlined />}
          disabled={checking}
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh
        </Button>
      }
    >
      {query.isError ? (
        <Alert
          showIcon
          type="error"
          title="Could not load scheduling activity"
          description={errorMessage(query.error)}
        />
      ) : !result ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : (
        <>
          <Table<SchedulingConfigurationAuditSummary>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={result.items}
            columns={[
              {
                key: "time",
                title: "Recorded at",
                render: (_, item) => <Time value={item.createdAt} />,
              },
              { key: "actor", title: "Actor", render: (_, item) => item.actor.subject },
              {
                key: "version",
                title: "Version",
                render: (_, item) => `${item.previousVersion} → ${item.version}`,
              },
              {
                key: "details",
                title: "Details",
                render: (_, item) => (
                  <Button size="small" onClick={() => setSelected(item)}>
                    View event
                  </Button>
                ),
              },
            ]}
            locale={{ emptyText: "No scheduling configuration changes have been recorded." }}
          />
          {result.total > 20 && (
            <Pagination
              current={page}
              pageSize={20}
              total={result.total}
              showSizeChanger={false}
              onChange={setPage}
              style={{ marginTop: 16 }}
            />
          )}
        </>
      )}
      {selected && !checking && (
        <SchedulingEvent
          key={selected.id}
          summary={selected}
          session={session}
          onClose={() => setSelected(null)}
        />
      )}
    </Card>
  );
}

function PlatformSchedulingSession({ session, checking }: { session: string; checking: boolean }) {
  useClearSchedulingSession(session);
  const client = useQueryClient();
  const [form] = Form.useForm<SchedulingLimitValues>();
  const [baseline, setBaseline] = useState<SchedulingConfiguration | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const query = useQuery({
    queryKey: [...schedulingPolicyQueryRoot, session, "platform"],
    queryFn: ({ signal }) => schedulingPolicy.platform(signal),
    enabled: !checking,
    refetchInterval: 5_000,
    retry: false,
    gcTime: 0,
  });
  useEffect(() => {
    if (!baseline && query.data) {
      setBaseline(query.data.configuration);
      form.setFieldsValue(schedulingLimitValues(query.data.configuration.limits));
    }
  }, [baseline, form, query.data]);
  const reload = async () => {
    try {
      const result = await query.refetch({ throwOnError: true });
      if (!result.data) return;
      setBaseline(result.data.configuration);
      form.setFieldsValue(schedulingLimitValues(result.data.configuration.limits));
      setDirty(false);
      setConflict(false);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };
  const save = async (values: SchedulingLimitValues) => {
    if (!baseline || !dirty || checking || conflict) return;
    setSaving(true);
    setError(null);
    try {
      const configuration = await schedulingPolicy.update({
        expectedVersion: baseline.version,
        limits: buildSchedulingLimits(values),
      });
      setBaseline(configuration);
      form.setFieldsValue(schedulingLimitValues(configuration.limits));
      setDirty(false);
      await client.invalidateQueries({ queryKey: schedulingPolicyQueryRoot });
      await client.invalidateQueries({ queryKey: ["scheduling-diagnostics"] });
    } catch (failure) {
      setError(errorMessage(failure));
      setConflict(isConfigurationConflict(failure));
    } finally {
      setSaving(false);
    }
  };
  const value: PlatformSchedulingStatus | undefined =
    !checking && !query.isError ? query.data : undefined;
  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Card
        className="system-panel"
        title="Global scheduling"
        extra={
          <Button
            icon={<ReloadOutlined />}
            loading={query.isFetching}
            disabled={checking || saving}
            onClick={() => void query.refetch()}
          >
            Refresh usage
          </Button>
        }
      >
        {schedulingPolicy.mode === "sample" && (
          <Alert
            style={{ marginBottom: 16 }}
            showIcon
            type="info"
            title="Sample scheduling data"
            description="This preview has fixed usage and isolated configuration history. Changes affect the preview only."
          />
        )}
        {query.isError ? (
          <Alert
            showIcon
            type="error"
            title="Could not load global scheduling"
            description={errorMessage(query.error)}
          />
        ) : !value ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : (
          <>
            <Typography.Paragraph type="secondary">
              Observed <Time value={value.observedAt} /> · Updates every 5 seconds
            </Typography.Paragraph>
            <Limits limits={value.configuration.limits} />
            <SchedulingUsageSummary usage={value.usage} overage={value.overage} />
            <Divider />
            <Typography.Title level={5}>Unscoped usage</Typography.Title>
            <Typography.Paragraph type="secondary">
              Work whose repository identity is unresolved still consumes global capacity.
            </Typography.Paragraph>
            <SchedulingUsageSummary usage={value.unscopedUsage} />
          </>
        )}
        <Divider />
        <Typography.Title level={5}>Global limits</Typography.Title>
        {baseline && (
          <Form
            form={form}
            layout="vertical"
            onValuesChange={() => setDirty(true)}
            onFinish={save}
            disabled={saving || checking}
          >
            <SchedulingLimitFields />
            {error && (
              <Alert
                style={{ marginBottom: 16 }}
                showIcon
                type="error"
                title={
                  conflict
                    ? "Scheduling configuration changed"
                    : "Could not save scheduling configuration"
                }
                description={
                  conflict
                    ? "Your edits are retained. Reload the latest settings before applying your changes again."
                    : error
                }
              />
            )}
            {baseline.version !== query.data?.configuration.version && query.data && (
              <Alert
                style={{ marginBottom: 16 }}
                type="warning"
                showIcon
                title="Newer settings are available"
                description="The current limits changed after this form was opened. Your edits have been retained."
              />
            )}
            <Space>
              <Button
                type="primary"
                htmlType="submit"
                loading={saving}
                disabled={!dirty || conflict || checking}
              >
                Save global limits
              </Button>
              <Button disabled={saving || checking} onClick={() => void reload()}>
                Reload latest settings
              </Button>
              {dirty && <Typography.Text type="secondary">Unsaved changes</Typography.Text>}
            </Space>
          </Form>
        )}
        <Divider />
        <Typography.Title level={5}>Service policy</Typography.Title>
        <Typography.Paragraph>
          Repositories share admission and Worker claims by successful service. Pull request and
          Issue work use a 2:1 service ratio when both are eligible. Priority gives a bounded
          preference; older eligible work continues to progress. Admission and claim ordering are
          independent.
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          Policy: repository-service-v1. Eligibility depends on current authorization, repository
          state, compatible Workers, backoff and capacity. These settings do not reserve capacity or
          predict an execution start.
        </Typography.Paragraph>
      </Card>
      <SchedulingActivity session={session} checking={checking} />
    </Space>
  );
}

export function PlatformSchedulingPolicy() {
  return (
    <SchedulingAccess>
      {(session, checking) => (
        <PlatformSchedulingSession key={session} session={session} checking={checking} />
      )}
    </SchedulingAccess>
  );
}
