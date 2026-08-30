import { CheckCircleOutlined, CloseCircleOutlined } from "@ant-design/icons";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import { PageContainer, ProTable } from "@ant-design/pro-components";
import { Button, Modal, message, Space, Tag, Tooltip, Typography } from "antd";
import { useRef } from "react";
import { StatusTag } from "@/components/StatusTag";
import { type Approval, reviewControl } from "@/services/review-control";
import { shortSha } from "@/utils/format";
import { asFilterValue, asSearchValue } from "@/utils/table";

const riskColor: Record<Approval["risk"], string> = {
  low: "green",
  medium: "orange",
  high: "red",
};

export default function ApprovalsPage() {
  const actionRef = useRef<ActionType>(null);
  const [messageApi, messageContext] = message.useMessage();
  const [modalApi, modalContext] = Modal.useModal();

  const decide = (approval: Approval, decision: "approve" | "reject") => {
    const approving = decision === "approve";
    modalApi.confirm({
      title: approving ? "Approve this request?" : "Reject this request?",
      content: (
        <Space direction="vertical" size={4}>
          <Typography.Text>{approval.workItemRef}</Typography.Text>
          <Typography.Text type="secondary">{approval.summary}</Typography.Text>
          <Typography.Text className="mono">Target: {shortSha(approval.targetSha)}</Typography.Text>
        </Space>
      ),
      okText: approving ? "Approve" : "Reject",
      okButtonProps: { danger: !approving },
      onOk: async () => {
        await reviewControl.decideApproval(approval.id, { decision });
        messageApi.success(approving ? "Request approved." : "Request rejected.");
        actionRef.current?.reload();
      },
    });
  };

  const columns: ProColumns<Approval>[] = [
    {
      title: "Search",
      dataIndex: "search",
      hideInTable: true,
      fieldProps: { placeholder: "Work item or summary" },
    },
    {
      title: "Work item",
      dataIndex: "workItemRef",
      width: 164,
      search: false,
      renderText: (value) => <Typography.Text strong>{value}</Typography.Text>,
    },
    {
      title: "Request",
      dataIndex: "summary",
      ellipsis: true,
      search: false,
    },
    {
      title: "Kind",
      dataIndex: "kind",
      width: 130,
      valueEnum: {
        validation: { text: "Validation" },
        publication: { text: "Publication" },
      },
      render: (_, record) => (
        <Tag color={record.kind === "validation" ? "purple" : "blue"}>
          {record.kind === "validation" ? "Validation" : "Publication"}
        </Tag>
      ),
    },
    {
      title: "Risk",
      dataIndex: "risk",
      width: 96,
      valueEnum: {
        low: { text: "Low" },
        medium: { text: "Medium" },
        high: { text: "High" },
      },
      render: (_, record) => <Tag color={riskColor[record.risk]}>{record.risk.toUpperCase()}</Tag>,
    },
    {
      title: "Target",
      dataIndex: "targetSha",
      width: 112,
      search: false,
      renderText: (value) => <Typography.Text className="mono">{shortSha(value)}</Typography.Text>,
    },
    {
      title: "Status",
      dataIndex: "status",
      width: 120,
      valueEnum: {
        pending: { text: "Pending" },
        approved: { text: "Approved" },
        rejected: { text: "Rejected" },
        expired: { text: "Expired" },
      },
      render: (_, record) => <StatusTag status={record.status} />,
    },
    {
      title: "Requested",
      dataIndex: "requestedAt",
      valueType: "dateTime",
      width: 168,
      search: false,
    },
    {
      title: "Decision",
      dataIndex: "decidedBy",
      width: 146,
      search: false,
      renderText: (value) => value ?? "Pending",
    },
    {
      title: "Actions",
      valueType: "option",
      fixed: "right",
      width: 106,
      render: (_, record) => [
        <Tooltip key="approve" title="Approve">
          <Button
            aria-label={`Approve ${record.id}`}
            disabled={record.status !== "pending"}
            icon={<CheckCircleOutlined />}
            onClick={() => decide(record, "approve")}
            type="text"
          />
        </Tooltip>,
        <Tooltip key="reject" title="Reject">
          <Button
            aria-label={`Reject ${record.id}`}
            danger
            disabled={record.status !== "pending"}
            icon={<CloseCircleOutlined />}
            onClick={() => decide(record, "reject")}
            type="text"
          />
        </Tooltip>,
      ],
    },
  ];

  return (
    <PageContainer
      className="operational-page"
      header={{ title: "Approvals", subTitle: "Validation and publication gates" }}
    >
      {messageContext}
      {modalContext}
      <ProTable<Approval>
        actionRef={actionRef}
        cardBordered={false}
        className="operational-table"
        columns={columns}
        headerTitle="Decision inbox"
        options={{ density: true, fullScreen: true, reload: true, setting: true }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        request={async (params) => {
          const result = await reviewControl.listApprovals({
            page: params.current,
            pageSize: params.pageSize,
            search: asSearchValue(params.search),
            filters: {
              kind: asFilterValue(params.kind),
              risk: asFilterValue(params.risk),
              status: asFilterValue(params.status),
            },
          });
          return { data: result.items, success: true, total: result.total };
        }}
        rowKey="id"
        scroll={{ x: 1280 }}
        search={{ labelWidth: "auto" }}
        size="small"
      />
    </PageContainer>
  );
}
