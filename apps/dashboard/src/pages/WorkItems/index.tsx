import { BranchesOutlined, GithubOutlined, IssuesCloseOutlined } from "@ant-design/icons";
import type { ProColumns } from "@ant-design/pro-components";
import { PageContainer, ProTable } from "@ant-design/pro-components";
import { Button, Space, Tag, Tooltip, Typography } from "antd";
import { StatusTag } from "@/components/StatusTag";
import { reviewControl, type WorkItem } from "@/services/review-control";
import { shortSha } from "@/utils/format";
import { asFilterValue, asSearchValue } from "@/utils/table";

const triggerLabels: Record<WorkItem["trigger"], string> = {
  assigned: "Assigned",
  review_requested: "Review requested",
  not_requested: "Not requested",
};

const authorizationPresentation: Record<
  WorkItem["authorization"],
  { color: string; label: string }
> = {
  self: { color: "cyan", label: "Self" },
  allowlisted: { color: "geekblue", label: "Allowlisted" },
  denied: { color: "error", label: "Denied" },
  pending: { color: "processing", label: "Pending" },
};

const schedulingActorLabel = (scheduledBy: string): string =>
  scheduledBy === "No scheduling actor" ? scheduledBy : `by ${scheduledBy}`;

export default function WorkItemsPage() {
  const columns: ProColumns<WorkItem>[] = [
    {
      title: "Search",
      dataIndex: "search",
      hideInTable: true,
      fieldProps: {
        allowClear: true,
        placeholder: "Repository, number, title, or actor",
      },
    },
    {
      title: "Type",
      dataIndex: "kind",
      width: 112,
      valueEnum: {
        pull_request: { text: "Pull request" },
        issue: { text: "Issue" },
      },
      render: (_, record) => (
        <Tag
          color={record.kind === "pull_request" ? "blue" : "purple"}
          icon={record.kind === "pull_request" ? <BranchesOutlined /> : <IssuesCloseOutlined />}
        >
          {record.kind === "pull_request" ? "PR" : "Issue"}
        </Tag>
      ),
    },
    {
      title: "Work item",
      dataIndex: "title",
      ellipsis: true,
      search: false,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Link href={record.githubUrl} target="_blank">
            {record.repository}#{record.number}
          </Typography.Link>
          <Typography.Text ellipsis={{ tooltip: record.title }}>{record.title}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "Trigger",
      dataIndex: "trigger",
      width: 138,
      search: false,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{triggerLabels[record.trigger]}</Typography.Text>
          <Typography.Text type="secondary">
            {schedulingActorLabel(record.scheduledBy)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: "Authorization",
      dataIndex: "authorization",
      width: 120,
      valueEnum: {
        self: { text: "Self" },
        allowlisted: { text: "Allowlisted" },
        denied: { text: "Denied" },
      },
      render: (_, record) => {
        const presentation = authorizationPresentation[record.authorization];
        return <Tag color={presentation.color}>{presentation.label}</Tag>;
      },
    },
    {
      title: "Stage",
      dataIndex: "stage",
      width: 150,
      valueEnum: {
        queued: { text: "Queued" },
        preparing: { text: "Preparing" },
        reviewing: { text: "Reviewing" },
        validating: { text: "Validating" },
        waiting_approval: { text: "Waiting approval" },
        publishing: { text: "Publishing" },
        done: { text: "Done" },
      },
      render: (_, record) => <StatusTag status={record.stage} />,
    },
    {
      title: "Revision",
      dataIndex: "headSha",
      width: 124,
      search: false,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text className="mono">{shortSha(record.headSha)}</Typography.Text>
          {record.freshness === "superseded" && (
            <Typography.Text type="warning">Superseded</Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: "Worker",
      dataIndex: "workerNodeId",
      width: 190,
      search: false,
      renderText: (value) => value ?? "Unassigned",
    },
    {
      title: "Updated",
      dataIndex: "updatedAt",
      valueType: "dateTime",
      width: 168,
      search: false,
    },
    {
      title: "Actions",
      valueType: "option",
      width: 64,
      fixed: "right",
      render: (_, record) => (
        <Tooltip key="github" title="Open on GitHub">
          <Button
            aria-label={`Open ${record.repository} number ${record.number} on GitHub`}
            href={record.githubUrl}
            icon={<GithubOutlined />}
            target="_blank"
            type="text"
          />
        </Tooltip>
      ),
    },
  ];

  return (
    <PageContainer
      className="operational-page"
      header={{
        title: "Work items",
        subTitle: "GitHub scheduling and authorization state",
      }}
    >
      <ProTable<WorkItem>
        cardBordered={false}
        className="operational-table"
        columns={columns}
        dateFormatter="string"
        headerTitle="Tracked work"
        options={{ density: true, fullScreen: true, reload: true, setting: true }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        request={async (params) => {
          const result = await reviewControl.listWorkItems({
            page: params.current,
            pageSize: params.pageSize,
            search: asSearchValue(params.search),
            filters: {
              authorization: asFilterValue(params.authorization),
              kind: asFilterValue(params.kind),
              stage: asFilterValue(params.stage),
            },
          });

          return { data: result.items, success: true, total: result.total };
        }}
        rowKey="id"
        scroll={{ x: 1420 }}
        search={{ labelWidth: "auto" }}
        size="small"
      />
    </PageContainer>
  );
}
