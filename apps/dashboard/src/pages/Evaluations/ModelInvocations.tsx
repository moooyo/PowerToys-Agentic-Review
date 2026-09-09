import type * as C from "@agentic-review/contracts";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Pagination,
  Skeleton,
  Space,
  Tag,
  Typography,
} from "antd";
import { useMemo, useState } from "react";
import {
  createHttpEvaluationModelInvocationAdapter,
  type EvaluationModelInvocationAdapter,
} from "@/services/evaluation-model-invocations";
import { armLabels } from "./batch-state";
import { useEvaluationPage, useEvaluationQuery } from "./context";
import {
  assertCellInvocationBinding,
  type CellInvocationBinding,
  cellInvocationBindingKey,
  invocationCollectionLabel,
  invocationOutcomeLabels,
  invocationReasonLabels,
} from "./model-invocation-state";
import { errorMessage } from "./state";

export function ModelInvocationHistory({ history }: { history: C.EvaluationCellInvocationListV1 }) {
  const expected = history.expectedRuntimeRegistration;
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        title="Recorded calls and identity"
        description="Collection checks show whether the saved records agree. Execution isolation and final result binding are not verified by these records, and they do not approve a pull request."
      />
      {expected ? (
        <Descriptions
          size="small"
          column={2}
          items={[
            { key: "registration", label: "Frozen configuration", children: expected.name },
            { key: "requested", label: "Requested model", children: expected.requestedModel },
            { key: "model", label: "Expected provider model", children: expected.identity.modelId },
            { key: "provider", label: "Expected provider", children: expected.identity.providerId },
          ]}
        />
      ) : (
        <Typography.Paragraph type="secondary">
          This cell has no registered model expectation.
        </Typography.Paragraph>
      )}
      {history.items.length === 0 ? (
        <Empty description="No model invocation has been recorded on this page." />
      ) : (
        history.items.map((item) => {
          const { opening, seal, submission, observedIdentity, callOutcomes } = item;
          const problematic = submission !== null && submission.consistency.state !== "matched";
          return (
            <Card
              key={opening.scope.invocationId}
              size="small"
              title={
                <Space wrap>
                  <Typography.Text strong>Attempt {opening.scope.attemptId}</Typography.Text>
                  <Tag color={problematic ? "warning" : undefined}>
                    {invocationCollectionLabel(item)}
                  </Tag>
                </Space>
              }
            >
              <Descriptions
                size="small"
                column={2}
                items={[
                  { key: "opened", label: "Recording opened", children: opening.openedAt },
                  { key: "worker", label: "Worker", children: opening.scope.workerNodeId },
                  {
                    key: "model",
                    label: "Recorded provider model",
                    children: observedIdentity?.modelId ?? "Not available",
                  },
                  {
                    key: "provider",
                    label: "Recorded provider",
                    children: observedIdentity?.providerId ?? "Not available",
                  },
                  {
                    key: "closure",
                    label: "Closure received",
                    children: seal?.recordedAt ?? "Not received",
                  },
                  {
                    key: "ledger",
                    label: "Call ledger received",
                    children: submission?.receivedAt ?? "Not received",
                  },
                  {
                    key: "cleanup",
                    label: "Cleanup",
                    children:
                      seal === null
                        ? "Not recorded"
                        : seal.processClosed && seal.relayClosed
                          ? "Process and relay closure recorded"
                          : "Unconfirmed",
                  },
                  { key: "execution", label: "Execution verification", children: "Not accepted" },
                ]}
              />
              {callOutcomes !== null ? (
                <Space wrap aria-label="Recorded call outcomes">
                  {Object.entries(callOutcomes)
                    .filter(([key, count]) => count > 0 || key === "completed")
                    .map(([key, count]) => (
                      <Tag key={key}>
                        {invocationOutcomeLabels[key as keyof typeof invocationOutcomeLabels]}:{" "}
                        {count}
                      </Tag>
                    ))}
                </Space>
              ) : (
                <Typography.Paragraph type="secondary">
                  {seal
                    ? `The closure declares ${seal.callCount} calls; their outcomes are unavailable until the ledger is received.`
                    : "An opening does not show whether a model is currently running or whether its calls completed."}
                </Typography.Paragraph>
              )}
              {submission?.consistency.reasons.length ? (
                <ul>
                  {submission.consistency.reasons.map((reason) => (
                    <li key={reason}>{invocationReasonLabels[reason]}</li>
                  ))}
                </ul>
              ) : null}
              <details style={{ marginTop: 12 }}>
                <summary>Identifiers and digests</summary>
                <Descriptions
                  size="small"
                  column={1}
                  style={{ marginTop: 12 }}
                  items={[
                    {
                      key: "invocation",
                      label: "Invocation",
                      children: (
                        <Typography.Text copyable>{opening.scope.invocationId}</Typography.Text>
                      ),
                    },
                    { key: "job", label: "Job", children: opening.scope.jobId },
                    {
                      key: "instance",
                      label: "Worker instance",
                      children: `${opening.scope.workerInstanceId} · lease generation ${opening.scope.leaseGeneration}`,
                    },
                    {
                      key: "client",
                      label: "Recorded CLI version",
                      children: opening.runtime.client.version,
                    },
                    {
                      key: "scope",
                      label: "Scope digest",
                      children: <Typography.Text copyable>{opening.scopeSha256}</Typography.Text>,
                    },
                    {
                      key: "ledger",
                      label: "Ledger digest",
                      children: seal ? (
                        <Typography.Text copyable>{seal.receiptSetSha256}</Typography.Text>
                      ) : (
                        "Not recorded"
                      ),
                    },
                    {
                      key: "output",
                      label: "Model output digest",
                      children: seal?.modelOutputSha256 ? (
                        <Typography.Text copyable>{seal.modelOutputSha256}</Typography.Text>
                      ) : (
                        "Not bound"
                      ),
                    },
                    {
                      key: "identity",
                      label: "Observed identity digest",
                      children: submission?.consistency.observedIdentitySha256 ? (
                        <Typography.Text copyable>
                          {submission.consistency.observedIdentitySha256}
                        </Typography.Text>
                      ) : (
                        "Not available"
                      ),
                    },
                  ]}
                />
              </details>
            </Card>
          );
        })
      )}
      <Typography.Text type="secondary">
        Snapshot: {history.sampledAt}. Refresh to retrieve a new snapshot.
      </Typography.Text>
    </Space>
  );
}

function InvocationContent({
  binding,
  adapter,
}: {
  binding: CellInvocationBinding;
  adapter: EvaluationModelInvocationAdapter;
}) {
  const page = useEvaluationPage();
  const [listPage, setListPage] = useState(1);
  const connected = page.api.mode === "connected";
  const query = useEvaluationQuery(
    ["model-invocation-history", page.repositoryId, cellInvocationBindingKey(binding), listPage],
    async (signal) => {
      const value = await adapter.list(binding.scope, { page: listPage, pageSize: 10 }, signal);
      assertCellInvocationBinding(value, binding);
      return value;
    },
    connected,
  );
  if (!connected)
    return (
      <Alert
        type="info"
        title="Server connection required"
        description="Model invocation history is available from a connected Server. Sample data does not create invocation records."
      />
    );
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Button
        disabled={!page.readable}
        loading={query.isFetching}
        onClick={() => void query.refetch()}
      >
        Refresh invocation history
      </Button>
      {!binding.modelRequired ? (
        <Typography.Paragraph type="secondary">
          This is a profile-only cell. Model execution was not requested.
        </Typography.Paragraph>
      ) : null}
      {query.isPending || query.isFetching ? (
        <Skeleton active paragraph={{ rows: 5 }} />
      ) : query.error ? (
        <Alert
          type="error"
          title="Invocation history unavailable"
          description={errorMessage(query.error)}
        />
      ) : query.data ? (
        <>
          <ModelInvocationHistory history={query.data} />
          <Pagination
            current={query.data.page}
            pageSize={query.data.pageSize}
            total={query.data.total}
            showSizeChanger={false}
            onChange={(next) => setListPage(next)}
            showTotal={(total) => `${total} recorded invocations`}
          />
        </>
      ) : null}
    </Space>
  );
}

export function ModelInvocationDrawer({
  binding,
  active,
  onClose,
  adapter,
}: {
  binding: CellInvocationBinding | null;
  active: boolean;
  onClose: () => void;
  adapter?: EvaluationModelInvocationAdapter;
}) {
  const page = useEvaluationPage();
  const api = useMemo(() => adapter ?? createHttpEvaluationModelInvocationAdapter(), [adapter]);
  const visible =
    active && page.readable && binding !== null && binding.scope.repositoryId === page.repositoryId;
  return (
    <Drawer
      title={
        binding
          ? `${armLabels[binding.arm]} model calls · ${binding.caseTitle}`
          : "Model invocation history"
      }
      open={visible}
      onClose={onClose}
      getContainer={false}
      rootStyle={{ position: "fixed" }}
      styles={{ wrapper: { maxWidth: "96vw" } }}
      size={960}
    >
      {visible ? (
        <InvocationContent
          key={`${page.session}:${cellInvocationBindingKey(binding)}`}
          binding={binding}
          adapter={api}
        />
      ) : null}
    </Drawer>
  );
}
