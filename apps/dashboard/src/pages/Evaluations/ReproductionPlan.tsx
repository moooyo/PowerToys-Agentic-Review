import type * as C from "@agentic-review/contracts";
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";
import { observationRefKey, observationRefLabel } from "@/components/IssueReproduction/state";
import { DataTable, DetailsGrid, EmptyState } from "@/components/ui";
import {
  createHttpEvaluationReproductionAdapter,
  type EvaluationReproductionAdapter,
} from "@/services/evaluation-reproduction";
import { armLabels } from "./batch-state";
import { useEvaluationPage, useEvaluationQuery } from "./context";
import { CopyValue } from "./Display";
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
    <Stack
      style={{
        width: "100%",
      }}
      direction="column"
      spacing={1.5}
      sx={{
        minWidth: 0,
      }}
    >
      <DetailsGrid
        items={[
          {
            key: "arm",
            label: "Arm",
            value: armLabels[record.arm],
          },
          {
            key: "state",
            label: "Frozen mapping",
            value: (
              <Chip
                label={
                  record.state === "ready"
                    ? "Mapping ready"
                    : record.state === "blocked"
                      ? "Blocked"
                      : "Not applicable"
                }
                color={record.state === "blocked" ? "warning" : "default"}
              />
            ),
          },
          {
            key: "cases",
            label: "Selected original cases",
            value: record.selectedCaseIds.join(", ") || "None",
          },
          {
            key: "digest",
            label: "Cell record digest",
            value: <CopyValue value={detail.cellRecordSha256} />,
          },
        ]}
        columns={2}
      />
      {record.blockers.length ? (
        <Alert severity={"warning"}>
          <AlertTitle>{"Frozen mapping blockers"}</AlertTitle>
          {
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
        </Alert>
      ) : null}
      {original ? (
        <>
          <Typography component="h5" variant="subtitle1">
            Original reproduction claim
          </Typography>
          <Typography component="p" variant="body2">
            {original.binding.claim}
          </Typography>
          {selected.map((entry) => (
            <OriginalReproductionCase key={entry.id} value={entry} />
          ))}
          {!selected.length ? (
            <p>No original reproduction cases were selected for this cell.</p>
          ) : null}
        </>
      ) : (
        <Typography component="p" variant="body2" color={"text.secondary"}>
          This source has no frozen reproduction definition.
        </Typography>
      )}
      {record.mappings ? (
        <>
          <DataTable
            rows={record.mappings.observationMappings}
            getRowId={(entry) => observationRefKey(entry.from)}
            columns={[
              {
                id: "from",
                label: "Original observation",
                render: (entry) => {
                  return observationRefLabel(entry.from);
                },
              },
              {
                id: "to",
                label: "Frozen arm observation",
                render: (entry) => {
                  return entry.to ? (
                    observationRefLabel(entry.to)
                  ) : (
                    <Chip label={"Unmapped"} color={"warning"} />
                  );
                },
              },
            ]}
            ariaLabel="Evaluation records"
          />
          {record.mappings.checkMappings.length ? (
            <DataTable
              rows={record.mappings.checkMappings}
              getRowId={(row) => row.fromCheckId}
              columns={[
                {
                  id: "fromCheckId",
                  label: "Original check precondition",
                  render: (row) => row.fromCheckId,
                },
                {
                  id: "to",
                  label: "Frozen arm check",
                  render: (entry) => {
                    return entry.toCheckId ?? <Chip label={"Unmapped"} color={"warning"} />;
                  },
                },
              ]}
              ariaLabel="Evaluation records"
            />
          ) : null}
        </>
      ) : null}
      <Typography component="p" variant="body2" color={"text.secondary"}>
        This is the mapping saved with the batch. A ready mapping does not establish execution,
        reproduction or a passing result. Later source or profile changes do not replace this
        record.
      </Typography>
    </Stack>
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
              {
                repositoryId: manifest.repositoryId,
                sourceId: reference.sourceId,
              },
              signal,
            )
          : Promise.resolve(null),
      ]);
      assertFrozenReproductionCell({
        detail,
        source,
        manifest,
        cell,
        profile,
      });
      return {
        detail,
        source,
      };
    },
    active,
  );
  return (
    <Card variant="outlined">
      <CardHeader
        title={"Frozen reproduction cell"}
        action={
          <Button
            disabled={!active}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
            variant="outlined"
          >
            Refresh record
          </Button>
        }
        slotProps={{
          title: {
            variant: "subtitle1",
            component: "h3",
          },
        }}
      />
      <CardContent>
        {query.error ? (
          <Alert severity={"error"}>
            <AlertTitle>{"Frozen mapping unavailable"}</AlertTitle>
            {errorMessage(query.error)}
          </Alert>
        ) : null}
        {query.data ? (
          <FrozenReproductionRecord
            detail={query.data.detail}
            original={query.data.source?.sourceDefinition ?? null}
          />
        ) : query.isFetching ? (
          <p>Loading the exact frozen reproduction record…</p>
        ) : null}
      </CardContent>
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
        {
          repositoryId: page.repositoryId,
          evaluationId: detail.summary.id,
        },
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
    <Card variant="elevation" elevation={0} className="evaluation-section-card">
      <CardHeader
        title={"Frozen reproduction plan"}
        slotProps={{
          title: {
            variant: "subtitle1",
            component: "h3",
          },
        }}
      />
      <CardContent>
        {query.error ? (
          <Alert
            action={
              <Button
                disabled={!active || !page.readable}
                onClick={() => void query.refetch()}
                variant="outlined"
              >
                Retry plan
              </Button>
            }
            severity={"error"}
          >
            <AlertTitle>{"Reproduction plan unavailable"}</AlertTitle>
            {errorMessage(query.error)}
          </Alert>
        ) : null}
        {query.data && !manifest ? (
          <EmptyState title={"This batch has no saved reproduction mapping manifest."} />
        ) : null}
        {manifest ? (
          <>
            <Typography component="p" variant="body2" color={"text.secondary"}>
              {manifest.sources.length} historical reproduction sources · {manifest.cells.length}{" "}
              frozen arm records. Select a cell to inspect its original requirements, explicit
              mappings and blockers.
            </Typography>
            <Autocomplete
              disabled={!active || !page.readable}
              style={{
                width: "100%",
                marginBottom: 16,
              }}
              options={cells.map((cell) => ({
                value: cell.cellId,
                label: `${cell.caseId} · ${armLabels[cell.arm]}`,
              }))}
              disablePortal
              fullWidth
              value={
                cells
                  .map((cell) => ({
                    value: cell.cellId,
                    label: `${cell.caseId} · ${armLabels[cell.arm]}`,
                  }))
                  .find((option) => option.value === (selected?.cellId ?? null)) ??
                ((selected?.cellId ?? null) == null || String(selected?.cellId ?? null) === ""
                  ? null
                  : {
                      value: (selected?.cellId ?? null) as NonNullable<
                        NonNullable<typeof selected>["cellId"]
                      >,
                      label: String(selected?.cellId ?? null),
                    })
              }
              onChange={(_event, option) => {
                if (option !== null)
                  setCellId(option.value as NonNullable<NonNullable<typeof selected>["cellId"]>);
              }}
              getOptionLabel={(option) => option.label}
              isOptionEqualToValue={(option, selected) => option.value === selected.value}
              getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={"Frozen reproduction cell"}
                  placeholder={"Select a batch cell"}
                  slotProps={{
                    ...params.slotProps,
                    htmlInput: {
                      ...params.slotProps.htmlInput,
                      "aria-label": "Frozen reproduction cell",
                    },
                  }}
                />
              )}
              disableClearable={Boolean(selected?.cellId ?? null)}
              getOptionKey={(option) => option.value}
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
      </CardContent>
    </Card>
  );
}
