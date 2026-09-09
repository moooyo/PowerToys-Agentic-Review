import { ReloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useModel } from "@umijs/max";
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Divider,
  Row,
  Skeleton,
  Statistic,
  Table,
  Typography,
} from "antd";
import { ModelRuntimeRegistrations } from "@/components/ModelRuntimeRegistrations";
import { OperatorAccessGate, useOperatorAccess } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import { PlatformSchedulingPolicy } from "@/components/SchedulingPolicy";
import { StatusTag } from "@/components/StatusTag";
import {
  type HealthComponent,
  reviewControl,
  type SystemSnapshot,
} from "@/services/review-control";
import "./index.css";

function ComponentHealth({ health }: { health: HealthComponent[] }) {
  const needsAttention = health.some((component) => component.status !== "healthy");

  return (
    <Card className="system-panel" title="Component health">
      <Typography.Paragraph type="secondary">
        The latest check from each control plane component.
      </Typography.Paragraph>
      {needsAttention && (
        <Alert
          className="system-health__notice"
          title="One or more components require attention. Review the details below."
          showIcon
          type="warning"
        />
      )}
      <Table<HealthComponent>
        columns={[
          { title: "Component", dataIndex: "name", width: 176 },
          {
            title: "Status",
            dataIndex: "status",
            width: 112,
            render: (status: HealthComponent["status"]) => <StatusTag status={status} />,
          },
          {
            title: "Details",
            dataIndex: "summary",
            render: (summary: string, component: HealthComponent) => (
              <div>
                <span className="system-health__summary">{summary}</span>
                <Typography.Text className="system-health__checked" type="secondary">
                  Last checked{" "}
                  <time dateTime={component.checkedAt}>
                    {new Date(component.checkedAt).toLocaleString()}
                  </time>
                </Typography.Text>
              </div>
            ),
          },
        ]}
        dataSource={health}
        locale={{ emptyText: "No component health checks were returned." }}
        pagination={false}
        rowKey="id"
        scroll={{ x: 480 }}
      />
    </Card>
  );
}

function ProcessingActivity({ snapshot }: { snapshot: SystemSnapshot }) {
  return (
    <Card className="system-panel" title="Processing activity">
      <Typography.Paragraph type="secondary">Current execution capacity.</Typography.Paragraph>
      <Row gutter={[24, 24]}>
        <Col span={12}>
          <Statistic title="Active workers" value={snapshot.activeWorkers} />
          <Typography.Text type="secondary">Online or draining</Typography.Text>
        </Col>
        <Col span={12}>
          <Statistic title="Active leases" value={snapshot.activeLeases} />
          <Typography.Text type="secondary">Leased or running attempts</Typography.Text>
        </Col>
      </Row>
      <Divider />
      <Row gutter={[24, 24]}>
        <Col span={8}>
          <Statistic title="Awaiting admission" value={snapshot.awaitingAdmissionJobs} />
          <Typography.Text type="secondary">Saved jobs waiting to enter the queue</Typography.Text>
        </Col>
        <Col span={8}>
          <Statistic title="Queued jobs" value={snapshot.queuedJobs} />
          <Typography.Text type="secondary">
            Admitted jobs waiting to start or retry
          </Typography.Text>
        </Col>
        <Col span={8}>
          <Statistic
            title="Requests awaiting prerequisites"
            value={snapshot.pendingValidationRequests}
          />
          <Typography.Text type="secondary">
            Pending validation requests with no job
          </Typography.Text>
        </Col>
      </Row>
      <Divider />
      <Descriptions
        column={1}
        layout="vertical"
        items={[
          {
            key: "oldest-pending",
            label: "Oldest job awaiting admission",
            children: snapshot.oldestAwaitingAdmissionAt ? (
              <time dateTime={snapshot.oldestAwaitingAdmissionAt}>
                {new Date(snapshot.oldestAwaitingAdmissionAt).toLocaleString()}
              </time>
            ) : (
              "No jobs awaiting admission"
            ),
          },
          {
            key: "oldest-queued",
            label: "Oldest queued job",
            children: snapshot.oldestQueuedAt ? (
              <time dateTime={snapshot.oldestQueuedAt}>
                {new Date(snapshot.oldestQueuedAt).toLocaleString()}
              </time>
            ) : (
              "No queued jobs"
            ),
          },
        ]}
      />
      <Typography.Text type="secondary">
        Creation time of the oldest job in each waiting group. Active and completed jobs are
        excluded.
      </Typography.Text>
    </Card>
  );
}

function RuntimeDetails({ snapshot }: { snapshot: SystemSnapshot }) {
  return (
    <Collapse
      items={[
        {
          key: "runtime",
          label: "Runtime details",
          children: (
            <>
              <Typography.Paragraph type="secondary">
                Versions and database storage
              </Typography.Paragraph>
              <Descriptions
                bordered
                column={{ xs: 1, sm: 2, lg: 3, xl: 5 }}
                layout="vertical"
                items={[
                  {
                    key: "server-version",
                    label: "Server version",
                    children: <Typography.Text code>{snapshot.serverVersion}</Typography.Text>,
                  },
                  {
                    key: "protocol-version",
                    label: "Protocol version",
                    children: <Typography.Text code>{snapshot.protocolVersion}</Typography.Text>,
                  },
                  {
                    key: "node-version",
                    label: "Node.js",
                    children: <Typography.Text code>{snapshot.nodeVersion}</Typography.Text>,
                  },
                  {
                    key: "sqlite-version",
                    label: "SQLite",
                    children: <Typography.Text code>{snapshot.sqliteVersion}</Typography.Text>,
                  },
                  {
                    key: "database-size",
                    label: "Database size",
                    children: `${snapshot.databaseSizeMb.toFixed(1)} MiB`,
                  },
                ]}
              />
            </>
          ),
        },
      ]}
    />
  );
}

export default function SystemPage() {
  return (
    <>
      <OperatorAccessGate platformOnly>
        <SystemContent />
      </OperatorAccessGate>
      <div style={{ marginTop: 24 }}>
        <ModelRuntimeRegistrations />
      </div>
    </>
  );
}

function SystemContent() {
  const access = useOperatorAccess();
  const { initialState } = useModel("@@initialState");
  const snapshotQuery = useQuery({
    queryKey: ["system-snapshot", ...access.identityKey, initialState?.authenticationEpoch ?? 0],
    queryFn: async ({ signal }) => {
      signal.throwIfAborted();
      const result = await reviewControl.getSystemSnapshot();
      signal.throwIfAborted();
      return result;
    },
    enabled: access.platformAdministrator && !access.checking,
    gcTime: 0,
    refetchInterval: 30_000,
  });
  const snapshot =
    !snapshotQuery.isError && access.platformAdministrator && !access.checking
      ? snapshotQuery.data
      : undefined;

  return (
    <section aria-labelledby="system-page-title" className="system-page">
      <PageHeader
        eyebrow="Operations"
        title="System"
        titleId="system-page-title"
        description="Monitor component health and processing activity."
        actions={
          <div className="system-page__actions">
            <span className="system-page__refresh-note">Updates every 30 seconds</span>
            <Button
              icon={<ReloadOutlined />}
              loading={snapshotQuery.isFetching}
              onClick={() => snapshotQuery.refetch()}
            >
              Refresh
            </Button>
          </div>
        }
      />

      {snapshotQuery.isLoading && (
        <Card className="system-panel" role="status">
          <Typography.Paragraph type="secondary">Loading system snapshot...</Typography.Paragraph>
          <Skeleton active paragraph={{ rows: 5 }} />
        </Card>
      )}
      {snapshotQuery.isError && (
        <Alert
          className="system-page__error"
          description="The control plane did not return a current system snapshot. Use Refresh to try again."
          title="System data is unavailable"
          showIcon
          type="error"
        />
      )}
      {snapshot && (
        <div className="system-page__content">
          <Row gutter={[24, 24]}>
            <Col xs={24} xl={16}>
              <ComponentHealth health={snapshot.health} />
            </Col>
            <Col xs={24} xl={8}>
              <ProcessingActivity snapshot={snapshot} />
            </Col>
          </Row>
          <RuntimeDetails snapshot={snapshot} />
          {snapshotQuery.dataUpdatedAt > 0 && (
            <p className="system-page__last-refreshed">
              Last refreshed{" "}
              <time dateTime={new Date(snapshotQuery.dataUpdatedAt).toISOString()}>
                {new Date(snapshotQuery.dataUpdatedAt).toLocaleString()}
              </time>
            </p>
          )}
        </div>
      )}
      <div style={{ marginTop: 24 }}>
        <PlatformSchedulingPolicy />
      </div>
    </section>
  );
}
