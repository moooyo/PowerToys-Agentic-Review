import type * as C from "@agentic-review/contracts";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useMemo, useState } from "react";
import { observationRefKey, observationRefLabel } from "@/components/IssueReproduction/state";
import {
  createHttpEvaluationReproductionAdapter,
  type EvaluationReproductionAdapter,
} from "@/services/evaluation-reproduction";
import { armLabels } from "./batch-state";
import { useEvaluationPage, useEvaluationQuery } from "./context";
import { OriginalReproductionCase } from "./ReproductionMapping";
import { assertFrozenReproductionCell, assertReproductionPlanScope } from "./reproduction-state";
import { errorMessage } from "./state";

export function FrozenReproductionRecord({
  detail,
  original,
}: {
  detail: C.EvaluationReproductionCellDetailV1;
  original: C.EvaluationReproductionSourceDefinitionV1 | null;
}) {
  const record = detail.record;
  const selected =
    original?.binding.cases.filter((entry) => record.selectedCaseIds.includes(entry.id)) ?? [];
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Descriptions
        size="small"
        column={2}
        items={[
          { key: "arm", label: "Arm", children: armLabels[record.arm] },
          {
            key: "state",
            label: "Frozen mapping",
            children: (
              <Tag color={record.state === "blocked" ? "warning" : undefined}>
                {record.state === "ready"
                  ? "Mapping ready"
                  : record.state === "blocked"
                    ? "Blocked"
                    : "Not applicable"}
              </Tag>
            ),
          },
          {
            key: "cases",
            label: "Selected original cases",
            children: record.selectedCaseIds.join(", ") || "None",
          },
          {
            key: "digest",
            label: "Cell record digest",
            children: <Typography.Text copyable>{detail.cellRecordSha256}</Typography.Text>,
          },
        ]}
      />
      {record.blockers.length ? (
        <Alert
          showIcon
          type="warning"
          title="Frozen mapping blockers"
          description={
            <ul>
              {[
                ...new Map(
                  record.blockers.map((blocker) => [
                    JSON.stringify([blocker.code, blocker.message]),
                    blocker,
                  ]),
                ).entries(),
              ].map(([key, blocker]) => (
                <li key={key}>{blocker.message}</li>
              ))}
            </ul>
          }
        />
      ) : null}
      {original ? (
        <>
          <Typography.Title level={5}>Original reproduction claim</Typography.Title>
          <Typography.Paragraph>{original.binding.claim}</Typography.Paragraph>
          {selected.map((entry) => (
            <OriginalReproductionCase key={entry.id} value={entry} />
          ))}
          {!selected.length ? (
            <p>No original reproduction cases were selected for this cell.</p>
          ) : null}
        </>
      ) : (
        <Typography.Paragraph type="secondary">
          This source has no frozen reproduction definition.
        </Typography.Paragraph>
      )}
      {record.mappings ? (
        <>
          <Table
            rowKey={(entry) => observationRefKey(entry.from)}
            size="small"
            pagination={false}
            scroll={{ x: 600 }}
            dataSource={record.mappings.observationMappings}
            columns={[
              {
                title: "Original observation",
                key: "from",
                render: (_, entry) => observationRefLabel(entry.from),
              },
              {
                title: "Frozen arm observation",
                key: "to",
                render: (_, entry) =>
                  entry.to ? observationRefLabel(entry.to) : <Tag color="warning">Unmapped</Tag>,
              },
            ]}
          />
          {record.mappings.checkMappings.length ? (
            <Table
              rowKey="fromCheckId"
              size="small"
              pagination={false}
              scroll={{ x: 600 }}
              dataSource={record.mappings.checkMappings}
              columns={[
                { title: "Original check precondition", dataIndex: "fromCheckId" },
                {
                  title: "Frozen arm check",
                  key: "to",
                  render: (_, entry) => entry.toCheckId ?? <Tag color="warning">Unmapped</Tag>,
                },
              ]}
            />
          ) : null}
        </>
      ) : null}
      <Typography.Paragraph type="secondary">
        This is the mapping saved with the batch. A ready mapping does not establish execution,
        reproduction or a passing result. Later source or profile changes do not replace this
        record.
      </Typography.Paragraph>
    </Space>
  );
}

function FrozenCell({
  api,
  manifest,
  cell,
  profile,
  active,
}: {
  api: EvaluationReproductionAdapter;
  manifest: C.EvaluationReproductionManifestV1;
  cell: C.EvaluationCellSummaryV1;
  profile: C.ValidationProfileVersionSummary;
  active: boolean;
}) {
  const reference = manifest.sources.find((entry) => entry.caseId === cell.caseId);
  const query = useEvaluationQuery(
    [
      "reproduction-cell-record",
      manifest.evaluationId,
      cell.cellId,
      manifest.cells.find((entry) => entry.cellId === cell.cellId)?.cellRecordSha256,
      reference?.sourceDefinitionSha256,
      profile.id,
      profile.configSha256,
    ],
    async (signal) => {
      const [detail, source] = await Promise.all([
        api.getCell(
          {
            repositoryId: manifest.repositoryId,
            evaluationId: manifest.evaluationId,
            cellId: cell.cellId,
          },
          signal,
        ),
        reference
          ? api.getSource(
              { repositoryId: manifest.repositoryId, sourceId: reference.sourceId },
              signal,
            )
          : Promise.resolve(null),
      ]);
      assertFrozenReproductionCell({ detail, source, manifest, cell, profile });
      return { detail, source };
    },
    active,
  );
  return (
    <Card
      size="small"
      title="Frozen reproduction cell"
      extra={
        <Button disabled={!active} loading={query.isFetching} onClick={() => void query.refetch()}>
          Refresh record
        </Button>
      }
    >
      {query.error ? (
        <Alert
          showIcon
          type="error"
          title="Frozen mapping unavailable"
          description={errorMessage(query.error)}
        />
      ) : null}
      {query.data ? (
        <FrozenReproductionRecord
          detail={query.data.detail}
          original={query.data.source?.sourceDefinition ?? null}
        />
      ) : query.isFetching ? (
        <p>Loading the exact frozen reproduction record…</p>
      ) : null}
    </Card>
  );
}

export function BatchReproductionPlan({
  detail,
  matrix,
  active,
  api: suppliedApi,
}: {
  detail: C.EvaluationBatchDetailV1;
  matrix: C.EvaluationBatchMatrixV1;
  active: boolean;
  api?: EvaluationReproductionAdapter;
}) {
  const page = useEvaluationPage();
  const defaultApi = useMemo(() => createHttpEvaluationReproductionAdapter(), []);
  const api = suppliedApi ?? defaultApi;
  const [cellId, setCellId] = useState<string | null>(null);
  const query = useEvaluationQuery(
    ["reproduction-batch-plan", detail.summary.id, detail.summary.suiteVersionId],
    async (signal) => {
      const value = await api.getPlan(
        { repositoryId: page.repositoryId, evaluationId: detail.summary.id },
        signal,
      );
      assertReproductionPlanScope(value, matrix);
      return value;
    },
    active,
  );
  const cells = matrix.cases.flatMap((entry) => [entry.baseline, entry.candidate]);
  const selected = cells.find((cell) => cell.cellId === cellId);
  const manifest = query.data?.manifest;
  return (
    <Card size="small" title="Frozen reproduction plan">
      {query.error ? (
        <Alert
          showIcon
          type="error"
          title="Reproduction plan unavailable"
          description={errorMessage(query.error)}
          action={
            <Button disabled={!active || !page.readable} onClick={() => void query.refetch()}>
              Retry plan
            </Button>
          }
        />
      ) : null}
      {query.data && !manifest ? (
        <Empty description="This batch has no saved reproduction mapping manifest." />
      ) : null}
      {manifest ? (
        <>
          <Typography.Paragraph type="secondary">
            {manifest.sources.length} historical reproduction sources · {manifest.cells.length}{" "}
            frozen arm records. Select a cell to inspect its original requirements, explicit
            mappings and blockers.
          </Typography.Paragraph>
          <Select
            aria-label="Frozen reproduction cell"
            placeholder="Select a batch cell"
            disabled={!active || !page.readable}
            style={{ width: "100%", marginBottom: 16 }}
            value={selected?.cellId ?? null}
            options={cells.map((cell) => ({
              value: cell.cellId,
              label: `${cell.caseId} · ${armLabels[cell.arm]}`,
            }))}
            onChange={setCellId}
          />
          {selected ? (
            <FrozenCell
              key={`${detail.summary.id}:${selected.cellId}`}
              api={api}
              manifest={manifest}
              cell={selected}
              profile={detail.configurations[selected.arm].profile}
              active={active && page.readable}
            />
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
