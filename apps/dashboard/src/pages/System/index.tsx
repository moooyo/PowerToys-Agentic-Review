import { ReloadOutlined } from "@ant-design/icons";
import type { ProColumns } from "@ant-design/pro-components";
import { PageContainer, ProTable } from "@ant-design/pro-components";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Descriptions, Skeleton, Space, Typography } from "antd";
import { StatusTag } from "@/components/StatusTag";
import {
  type HealthComponent,
  reviewControl,
  type SystemSnapshot,
} from "@/services/review-control";

const healthColumns: ProColumns<HealthComponent>[] = [
  {
    title: "Component",
    dataIndex: "name",
    width: 220,
    renderText: (value) => <Typography.Text strong>{value}</Typography.Text>,
  },
  {
    title: "Status",
    dataIndex: "status",
    width: 130,
    render: (_, record) => <StatusTag status={record.status} />,
  },
  {
    title: "Summary",
    dataIndex: "summary",
    ellipsis: true,
  },
  {
    title: "Checked",
    dataIndex: "checkedAt",
    valueType: "dateTime",
    width: 180,
  },
];

function ControlPlaneSummary({ snapshot }: { snapshot: SystemSnapshot }) {
  return (
    <Descriptions
      bordered
      column={{ xs: 1, sm: 2, lg: 4 }}
      items={[
        { key: "serverVersion", label: "Server version", children: snapshot.serverVersion },
        { key: "protocolVersion", label: "Protocol version", children: snapshot.protocolVersion },
        { key: "nodeVersion", label: "Node.js", children: snapshot.nodeVersion },
        { key: "sqliteVersion", label: "SQLite", children: snapshot.sqliteVersion },
        {
          key: "databaseSizeMb",
          label: "Database",
          children: `${snapshot.databaseSizeMb.toFixed(1)} MB`,
        },
        { key: "activeWorkers", label: "Active workers", children: snapshot.activeWorkers },
        { key: "activeLeases", label: "Active leases", children: snapshot.activeLeases },
        {
          key: "pendingApprovals",
          label: "Pending approvals",
          children: snapshot.pendingApprovals,
        },
        {
          key: "oldestQueuedAt",
          label: "Oldest queued",
          children: snapshot.oldestQueuedAt
            ? new Date(snapshot.oldestQueuedAt).toLocaleString()
            : "None",
        },
      ]}
      size="small"
      title="Control plane"
    />
  );
}

export default function SystemPage() {
  const snapshotQuery = useQuery({
    queryKey: ["system-snapshot"],
    queryFn: () => reviewControl.getSystemSnapshot(),
    refetchInterval: 30_000,
  });
  const snapshot = snapshotQuery.data;
  const degraded = snapshot?.health.some((component) => component.status !== "healthy");

  return (
    <PageContainer
      className="operational-page"
      extra={[
        <Button
          key="refresh"
          icon={<ReloadOutlined />}
          loading={snapshotQuery.isFetching}
          onClick={() => snapshotQuery.refetch()}
        >
          Refresh
        </Button>,
      ]}
      header={{ title: "System" }}
    >
      {snapshotQuery.isLoading && <Skeleton active paragraph={{ rows: 5 }} />}
      {snapshotQuery.isError && (
        <Alert
          description="The control plane did not return a system snapshot."
          message="System data is unavailable"
          showIcon
          type="error"
        />
      )}
      {snapshot && (
        <Space direction="vertical" size={16} style={{ display: "flex" }}>
          {degraded && (
            <Alert
              message="One or more system components require attention."
              showIcon
              type="warning"
            />
          )}
          <ControlPlaneSummary snapshot={snapshot} />
          <ProTable<HealthComponent>
            cardBordered={false}
            className="operational-table"
            columns={healthColumns}
            dataSource={snapshot.health}
            headerTitle="Component health"
            options={false}
            pagination={false}
            rowKey="id"
            scroll={{ x: true }}
            search={false}
            size="small"
          />
        </Space>
      )}
    </PageContainer>
  );
}
