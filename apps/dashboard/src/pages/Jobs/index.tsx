import type { ProColumns } from "@ant-design/pro-components";
import { PageContainer, ProTable } from "@ant-design/pro-components";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Grid,
  List,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import { useCallback, useRef, useState } from "react";
import { LeaseCountdown } from "@/components/LeaseCountdown";
import { StatusTag } from "@/components/StatusTag";
import { type Job, type JobDetails, reviewControl } from "@/services/review-control";
import { formatDuration, shortSha } from "@/utils/format";
import { asFilterValue, asSearchValue } from "@/utils/table";

const assessmentLabel: Record<"approve" | "comment" | "request_changes", string> = {
  approve: "Approve",
  comment: "Comment",
  request_changes: "Request changes",
};

const priorityLabel: Record<0 | 1 | 2 | 3, string> = {
  0: "P0",
  1: "P1",
  2: "P2",
  3: "P3",
};

const issueCategoryLabel: Record<
  "bug" | "feature_request" | "documentation" | "question" | "support" | "other",
  string
> = {
  bug: "Bug",
  feature_request: "Feature request",
  documentation: "Documentation",
  question: "Question",
  support: "Support",
  other: "Other",
};

export default function JobsPage() {
  const screens = Grid.useBreakpoint();
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobDetails, setJobDetails] = useState<JobDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const detailsRequestGeneration = useRef(0);

  const loadJobDetails = useCallback(async (jobId: string) => {
    const requestGeneration = detailsRequestGeneration.current + 1;
    detailsRequestGeneration.current = requestGeneration;
    setSelectedJobId(jobId);
    setDetailsLoading(true);
    setDetailsError(null);
    try {
      const job = await reviewControl.getJob(jobId);
      if (detailsRequestGeneration.current !== requestGeneration) {
        return;
      }
      setJobDetails(job);
    } catch (error) {
      if (detailsRequestGeneration.current !== requestGeneration) {
        return;
      }
      const message = error instanceof Error ? error.message : "Unable to load job details.";
      setDetailsError(message);
      setJobDetails(null);
    } finally {
      if (detailsRequestGeneration.current === requestGeneration) {
        setDetailsLoading(false);
      }
    }
  }, []);

  const closeDrawer = useCallback(() => {
    detailsRequestGeneration.current += 1;
    setSelectedJobId(null);
    setJobDetails(null);
    setDetailsLoading(false);
    setDetailsError(null);
  }, []);

  const drawerOpen = selectedJobId !== null;

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
      width: 220,
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
    {
      title: "Actions",
      key: "actions",
      valueType: "option",
      width: 96,
      fixed: "right",
      render: (_, record) => [
        <Button
          key="details"
          size="small"
          type="link"
          onClick={() => void loadJobDetails(record.id)}
        >
          Details
        </Button>,
      ],
    },
  ];

  return (
    <PageContainer className="operational-page" header={{ title: "Jobs" }}>
      <ProTable<Job>
        cardBordered={false}
        className="operational-table"
        columns={columns}
        columnsState={{
          defaultValue: {
            attempt: { show: false },
            leaseExpiresAt: { show: false },
            targetSha: { show: false },
          },
          persistenceKey: "agentic-review:jobs:columns:v1",
          persistenceType: "localStorage",
        }}
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
        scroll={{ x: true }}
        search={{ labelWidth: "auto" }}
        size="small"
      />

      <Drawer
        destroyOnClose
        onClose={closeDrawer}
        open={drawerOpen}
        title={selectedJobId === null ? "Job details" : `Job ${selectedJobId}`}
        width={screens.lg ? 860 : "100%"}
      >
        {detailsLoading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 36 }}>
            <Spin size="large" />
          </div>
        ) : detailsError !== null ? (
          <Alert
            showIcon
            message="Unable to load job details"
            description={detailsError}
            type="error"
          />
        ) : jobDetails === null ? (
          <Empty description="This job no longer exists." />
        ) : (
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Descriptions bordered column={1} size="small" title="Execution">
              <Descriptions.Item label="Work item">{jobDetails.workItemRef}</Descriptions.Item>
              <Descriptions.Item label="Status">
                <Space>
                  <StatusTag status={jobDetails.status} />
                  <StatusTag status={jobDetails.stage} />
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="Attempt">{`${jobDetails.attempt}/${jobDetails.maxAttempts}`}</Descriptions.Item>
              <Descriptions.Item label="Worker">
                {jobDetails.workerNodeId ?? "Unassigned"}
              </Descriptions.Item>
              <Descriptions.Item label="Lease">
                <LeaseCountdown expiresAt={jobDetails.leaseExpiresAt} />
              </Descriptions.Item>
              <Descriptions.Item label="Elapsed">
                {formatDuration(jobDetails.elapsedSeconds)}
              </Descriptions.Item>
              <Descriptions.Item label="Revision">
                <Typography.Text className="mono">{shortSha(jobDetails.targetSha)}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="Failure code">
                {jobDetails.failureCode ?? "-"}
              </Descriptions.Item>
              <Descriptions.Item label="Failure message">
                {jobDetails.failureMessage ?? "-"}
              </Descriptions.Item>
            </Descriptions>

            {jobDetails.reviewResult === null ? (
              <Empty
                description="No persisted review result for this job."
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ) : (
              <>
                <Descriptions bordered column={1} size="small" title="Review result">
                  <Descriptions.Item label="Schema">
                    {jobDetails.reviewResult.schemaId}
                  </Descriptions.Item>
                  <Descriptions.Item label="Summary">
                    {jobDetails.reviewResult.summary}
                  </Descriptions.Item>
                  <Descriptions.Item label="Result digest">
                    <Typography.Text className="mono" copyable>
                      {jobDetails.reviewResult.resultDigest}
                    </Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label="Requested recipes">
                    {jobDetails.reviewResult.requestedRecipeIds.length === 0
                      ? "None"
                      : jobDetails.reviewResult.requestedRecipeIds.map((recipeId) => (
                          <Tag key={recipeId}>{recipeId}</Tag>
                        ))}
                  </Descriptions.Item>
                </Descriptions>

                {jobDetails.reviewResult.prReview !== null && (
                  <>
                    <Space align="center">
                      <Typography.Title level={5} style={{ margin: 0 }}>
                        PR Findings
                      </Typography.Title>
                      <Tag color="blue">
                        {assessmentLabel[jobDetails.reviewResult.prReview.assessment]}
                      </Tag>
                    </Space>
                    <List
                      bordered
                      dataSource={jobDetails.reviewResult.prReview.findings}
                      locale={{ emptyText: "No findings." }}
                      renderItem={(finding) => (
                        <List.Item key={finding.findingId}>
                          <Space direction="vertical" size={2} style={{ width: "100%" }}>
                            <Space wrap>
                              <Tag color="geekblue">{priorityLabel[finding.priority]}</Tag>
                              <Typography.Text strong>{finding.title}</Typography.Text>
                            </Space>
                            <Typography.Text className="mono">
                              {`${finding.path}:${finding.line}${finding.endLine === null ? "" : `-${finding.endLine}`}`}
                            </Typography.Text>
                            <Typography.Paragraph style={{ marginBottom: 0 }}>
                              {finding.body}
                            </Typography.Paragraph>
                          </Space>
                        </List.Item>
                      )}
                      size="small"
                    />
                  </>
                )}

                {jobDetails.reviewResult.issueTriage !== null && (
                  <>
                    <Typography.Title level={5} style={{ marginBottom: 0 }}>
                      Issue Triage
                    </Typography.Title>
                    <Descriptions bordered column={1} size="small">
                      <Descriptions.Item label="Category">
                        {issueCategoryLabel[jobDetails.reviewResult.issueTriage.category]}
                      </Descriptions.Item>
                      <Descriptions.Item label="Priority">
                        {priorityLabel[jobDetails.reviewResult.issueTriage.priority]}
                      </Descriptions.Item>
                      <Descriptions.Item label="Confidence">
                        {`${Math.round(jobDetails.reviewResult.issueTriage.confidence * 100)}%`}
                      </Descriptions.Item>
                      <Descriptions.Item label="Suggested labels">
                        {jobDetails.reviewResult.issueTriage.suggestedLabels.length === 0
                          ? "None"
                          : jobDetails.reviewResult.issueTriage.suggestedLabels.map((label) => (
                              <Tag key={label}>{label}</Tag>
                            ))}
                      </Descriptions.Item>
                      <Descriptions.Item label="Missing information">
                        {jobDetails.reviewResult.issueTriage.missingInformation.length === 0 ? (
                          "None"
                        ) : (
                          <List
                            dataSource={jobDetails.reviewResult.issueTriage.missingInformation}
                            renderItem={(item) => <List.Item>{item}</List.Item>}
                            size="small"
                          />
                        )}
                      </Descriptions.Item>
                      <Descriptions.Item label="Duplicate candidates">
                        {jobDetails.reviewResult.issueTriage.duplicateCandidates.length === 0 ? (
                          "None"
                        ) : (
                          <List
                            dataSource={jobDetails.reviewResult.issueTriage.duplicateCandidates}
                            renderItem={(candidate) => (
                              <List.Item>{`#${candidate.number}: ${candidate.reason}`}</List.Item>
                            )}
                            size="small"
                          />
                        )}
                      </Descriptions.Item>
                    </Descriptions>
                  </>
                )}
              </>
            )}
          </Space>
        )}
      </Drawer>
    </PageContainer>
  );
}
