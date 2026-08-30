import type { ProColumns } from "@ant-design/pro-components";
import { PageContainer, ProTable } from "@ant-design/pro-components";
import { Progress, Space, Tag, Typography } from "antd";
import { StatusTag } from "@/components/StatusTag";
import { reviewControl, type WorkerNode } from "@/services/review-control";
import { asFilterValue, asSearchValue } from "@/utils/table";

export default function WorkersPage() {
  const columns: ProColumns<WorkerNode>[] = [
    {
      title: "Search",
      dataIndex: "search",
      hideInTable: true,
      fieldProps: { placeholder: "Worker, instance, or location" },
    },
    {
      title: "Worker",
      dataIndex: "id",
      width: 230,
      search: false,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.id}</Typography.Text>
          <Typography.Text className="mono" type="secondary">
            {record.instanceId}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: "Status",
      dataIndex: "status",
      width: 122,
      valueEnum: {
        online: { text: "Online" },
        draining: { text: "Draining" },
        offline: { text: "Offline" },
        disabled: { text: "Disabled" },
      },
      render: (_, record) => <StatusTag status={record.status} />,
    },
    {
      title: "Location",
      dataIndex: "location",
      width: 120,
      search: false,
    },
    {
      title: "Slots",
      dataIndex: "activeSlots",
      width: 150,
      search: false,
      render: (_, record) => (
        <Progress
          percent={Math.round((record.activeSlots / record.maxSlots) * 100)}
          size="small"
          format={() => `${record.activeSlots}/${record.maxSlots}`}
        />
      ),
    },
    {
      title: "Capabilities",
      dataIndex: "capabilities",
      search: false,
      render: (_, record) => (
        <Space size={[4, 4]} wrap>
          {record.capabilities.map((capability) => (
            <Tag key={capability}>{capability}</Tag>
          ))}
        </Space>
      ),
    },
    {
      title: "Current jobs",
      dataIndex: "currentJobs",
      width: 180,
      search: false,
      render: (_, record) =>
        record.currentJobs.length > 0 ? (
          <Space direction="vertical" size={0}>
            {record.currentJobs.map((job) => (
              <Typography.Text className="mono" key={job}>
                {job}
              </Typography.Text>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">Idle</Typography.Text>
        ),
    },
    {
      title: "Disk free",
      dataIndex: "diskFreeGb",
      width: 104,
      search: false,
      renderText: (value) => `${value} GB`,
    },
    {
      title: "Heartbeat",
      dataIndex: "lastHeartbeatAt",
      valueType: "dateTime",
      width: 168,
      search: false,
    },
    {
      title: "Version",
      dataIndex: "version",
      width: 92,
      search: false,
    },
  ];

  return (
    <PageContainer className="operational-page" header={{ title: "Workers" }}>
      <ProTable<WorkerNode>
        cardBordered={false}
        className="operational-table"
        columns={columns}
        headerTitle="Windows worker pool"
        options={{ density: true, fullScreen: true, reload: true, setting: true }}
        pagination={false}
        request={async (params) => {
          const result = await reviewControl.listWorkers({
            page: 1,
            pageSize: 100,
            search: asSearchValue(params.search),
            filters: { status: asFilterValue(params.status) },
          });
          return { data: result.items, success: true, total: result.total };
        }}
        rowKey="id"
        scroll={{ x: 1440 }}
        search={{ labelWidth: "auto" }}
        size="small"
      />
    </PageContainer>
  );
}
