import type { ProColumns } from "@ant-design/pro-components";
import { PageContainer, ProTable } from "@ant-design/pro-components";
import { Space, Typography } from "antd";
import { LeaseCountdown } from "@/components/LeaseCountdown";
import { StatusTag } from "@/components/StatusTag";
import { type Job, reviewControl } from "@/services/review-control";
import { formatDuration, shortSha } from "@/utils/format";
import { asFilterValue, asSearchValue } from "@/utils/table";

export default function JobsPage() {
  const columns: ProColumns<Job>[] = [
    {
      title: "Search",
      dataIndex: "search",
      hideInTable: true,
      fieldProps: { placeholder: "Job, work item, or worker" },
    },
    {
      title: "Job",
      dataIndex: "id",
      search: false,
      width: 174,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text className="mono" copyable>
            {record.id}
          </Typography.Text>
          <Typography.Text type="secondary">generation {record.generation}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "Work item",
      dataIndex: "workItemRef",
      width: 152,
      search: false,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.workItemRef}</Typography.Text>
          <Typography.Text type="secondary">{record.title}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "Status",
      dataIndex: "status",
      width: 174,
      valueEnum: {
        queued: { text: "Queued" },
        leased: { text: "Leased" },
        running: { text: "Running" },
        cancel_requested: { text: "Cancel requested" },
        retry_waiting: { text: "Retry waiting" },
        succeeded: { text: "Succeeded" },
        failed: { text: "Failed" },
        cancelled: { text: "Cancelled" },
        stale: { text: "Stale" },
        dead_letter: { text: "Dead letter" },
      },
      render: (_, record) => <StatusTag status={record.status} />,
    },
    {
      title: "Stage",
      dataIndex: "stage",
      width: 138,
      valueEnum: {
        queued: { text: "Queued" },
        leased: { text: "Leased" },
        preparing: { text: "Preparing" },
        codex_review: { text: "Codex review" },
        validation: { text: "Validation" },
        codex_revision: { text: "Codex revision" },
        uploading: { text: "Uploading" },
        completing: { text: "Completing" },
        cancelling: { text: "Cancelling" },
        done: { text: "Done" },
      },
      render: (_, record) => <StatusTag status={record.stage} />,
    },
    {
      title: "Attempt",
      dataIndex: "attempt",
      width: 94,
      search: false,
      renderText: (_, record) => `${record.attempt}/${record.maxAttempts}`,
    },
    {
      title: "Worker",
      dataIndex: "workerNodeId",
      width: 196,
      search: false,
      renderText: (value) => value ?? "Unassigned",
    },
    {
      title: "Lease",
      dataIndex: "leaseExpiresAt",
      width: 112,
      search: false,
      render: (_, record) => <LeaseCountdown expiresAt={record.leaseExpiresAt} />,
    },
    {
      title: "Revision",
      dataIndex: "targetSha",
      width: 108,
      search: false,
      renderText: (value) => <Typography.Text className="mono">{shortSha(value)}</Typography.Text>,
    },
    {
      title: "Elapsed",
      dataIndex: "elapsedSeconds",
      width: 100,
      search: false,
      renderText: (value) => formatDuration(value),
    },
    {
      title: "Created",
      dataIndex: "createdAt",
      valueType: "dateTime",
      width: 168,
      search: false,
    },
  ];

  return (
    <PageContainer className="operational-page" header={{ title: "Jobs" }}>
      <ProTable<Job>
        cardBordered={false}
        className="operational-table"
        columns={columns}
        headerTitle="Execution queue"
        options={{ density: true, fullScreen: true, reload: true, setting: true }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        request={async (params) => {
          const result = await reviewControl.listJobs({
            page: params.current,
            pageSize: params.pageSize,
            search: asSearchValue(params.search),
            filters: {
              stage: asFilterValue(params.stage),
              status: asFilterValue(params.status),
            },
          });
          return { data: result.items, success: true, total: result.total };
        }}
        rowKey="id"
        scroll={{ x: 1540 }}
        search={{ labelWidth: "auto" }}
        size="small"
      />
    </PageContainer>
  );
}
