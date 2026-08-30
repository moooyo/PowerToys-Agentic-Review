import { ExportOutlined, RedoOutlined } from "@ant-design/icons";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import { PageContainer, ProTable } from "@ant-design/pro-components";
import { Button, message, Tooltip, Typography } from "antd";
import { useRef } from "react";
import { StatusTag } from "@/components/StatusTag";
import { type Publication, reviewControl } from "@/services/review-control";
import { shortSha } from "@/utils/format";
import { asFilterValue, asSearchValue } from "@/utils/table";

export default function PublicationsPage() {
  const actionRef = useRef<ActionType>(null);
  const [messageApi, messageContext] = message.useMessage();

  const columns: ProColumns<Publication>[] = [
    {
      title: "Search",
      dataIndex: "search",
      hideInTable: true,
      fieldProps: { placeholder: "Publication, work item, or error" },
    },
    {
      title: "Publication",
      dataIndex: "id",
      width: 188,
      search: false,
      renderText: (value) => (
        <Typography.Text className="mono" copyable>
          {value}
        </Typography.Text>
      ),
    },
    {
      title: "Work item",
      dataIndex: "workItemRef",
      width: 160,
      search: false,
      renderText: (value) => <Typography.Text strong>{value}</Typography.Text>,
    },
    {
      title: "Kind",
      dataIndex: "kind",
      width: 164,
      valueEnum: {
        issue_comment: { text: "Issue comment" },
        pull_request_review: { text: "PR review" },
        check_run: { text: "Check run" },
      },
      renderText: (value) => value.replaceAll("_", " "),
    },
    {
      title: "Status",
      dataIndex: "status",
      width: 122,
      valueEnum: {
        ready: { text: "Ready" },
        pending: { text: "Pending" },
        published: { text: "Published" },
        failed: { text: "Failed" },
        unknown: { text: "Unknown" },
      },
      render: (_, record) => <StatusTag status={record.status} />,
    },
    {
      title: "Target",
      dataIndex: "targetSha",
      width: 112,
      search: false,
      renderText: (value) => <Typography.Text className="mono">{shortSha(value)}</Typography.Text>,
    },
    {
      title: "Attempts",
      dataIndex: "attempts",
      width: 90,
      search: false,
    },
    {
      title: "Last result",
      dataIndex: "lastError",
      ellipsis: true,
      search: false,
      render: (_, record) => (
        <Typography.Text type={record.lastError ? "danger" : "secondary"}>
          {record.lastError ?? "No error recorded"}
        </Typography.Text>
      ),
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
      fixed: "right",
      width: 104,
      render: (_, record) => [
        <Tooltip key="open" title="Open remote publication">
          <Button
            aria-label={`Open ${record.id} on GitHub`}
            disabled={!record.remoteUrl}
            href={record.remoteUrl}
            icon={<ExportOutlined />}
            target="_blank"
            type="text"
          />
        </Tooltip>,
        <Tooltip key="retry" title="Retry publication">
          <Button
            aria-label={`Retry ${record.id}`}
            disabled={!["failed", "unknown"].includes(record.status)}
            icon={<RedoOutlined />}
            onClick={async () => {
              await reviewControl.retryPublication(record.id);
              messageApi.success("Publication retry was queued.");
              actionRef.current?.reload();
            }}
            type="text"
          />
        </Tooltip>,
      ],
    },
  ];

  return (
    <PageContainer className="operational-page" header={{ title: "Publications" }}>
      {messageContext}
      <ProTable<Publication>
        actionRef={actionRef}
        cardBordered={false}
        className="operational-table"
        columns={columns}
        headerTitle="GitHub outbox"
        options={{ density: true, fullScreen: true, reload: true, setting: true }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        request={async (params) => {
          const result = await reviewControl.listPublications({
            page: params.current,
            pageSize: params.pageSize,
            search: asSearchValue(params.search),
            filters: {
              kind: asFilterValue(params.kind),
              status: asFilterValue(params.status),
            },
          });
          return { data: result.items, success: true, total: result.total };
        }}
        rowKey="id"
        scroll={{ x: 1220 }}
        search={{ labelWidth: "auto" }}
        size="small"
      />
    </PageContainer>
  );
}
