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
import { useEffect, useState } from "react";
import { DataTable, DetailsGrid } from "@/components/ui";
import { useEvaluationPage, useEvaluationQuery } from "./context";
import { CopyValue } from "./Display";
import { CaseSourceLabel, FrozenSourceLabel, SourceDetails } from "./Sources";
import { collectCatalog, errorMessage } from "./state";
export function PublishedVersion({
  suiteId,
  preferredVersionId,
  active,
  sources,
}: {
  suiteId: string;
  preferredVersionId: string | null;
  active: boolean;
  sources: C.EvaluationSourceSummaryV1[];
}) {
  const page = useEvaluationPage();
  const [selected, setSelected] = useState<string | null>(preferredVersionId),
    [caseId, setCaseId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const scope = {
    repositoryId: page.repositoryId,
    suiteId,
  };
  const versions = useEvaluationQuery(
    ["versions", suiteId],
    (signal) =>
      collectCatalog((number) =>
        page.api.listSuiteVersions(
          scope,
          {
            page: number,
            pageSize: 50,
          },
          signal,
        ),
      ),
    active,
  );
  useEffect(() => {
    if (active && selected === null) {
      const initialVersionId = preferredVersionId ?? versions.data?.[0]?.id;
      if (initialVersionId) setSelected(initialVersionId);
    }
  }, [active, selected, preferredVersionId, versions.data]);
  const versionId = selected;
  const versionScope = {
    ...scope,
    versionId: versionId ?? "",
  };
  const version = useEvaluationQuery(
    ["version", suiteId, versionId],
    (signal) => page.api.getSuiteVersion(versionScope, signal),
    active && versionId !== null,
  );
  const cases = useEvaluationQuery(
    ["cases", suiteId, versionId],
    (signal) => page.api.listSuiteCases(versionScope, signal),
    active && versionId !== null,
  );
  const detail = useEvaluationQuery(
    ["case", suiteId, versionId, caseId],
    (signal) =>
      page.api.getSuiteCase(
        {
          ...versionScope,
          caseId: caseId ?? "",
        },
        signal,
      ),
    active && versionId !== null && caseId !== null,
  );
  const error = versions.error ?? version.error ?? cases.error ?? detail.error;
  return (
    <div className="evaluation-version">
      <Alert severity={"info"}>
        <AlertTitle>{"Published versions are immutable"}</AlertTitle>
        {
          "These sources and expectations belong to this exact version. Later draft edits cannot change them."
        }
      </Alert>
      {error ? (
        <Alert severity={"error"}>
          <AlertTitle>{"Published version unavailable"}</AlertTitle>
          {errorMessage(error)}
        </Alert>
      ) : null}
      <Autocomplete
        loading={versions.isFetching}
        className="evaluation-version-select"
        options={(versions.data ?? []).map((entry) => ({
          value: entry.id,
          label: `Version ${entry.version} · ${entry.caseCount} cases · ${entry.createdAt}`,
        }))}
        disablePortal
        fullWidth
        value={
          (versions.data ?? [])
            .map((entry) => ({
              value: entry.id,
              label: `Version ${entry.version} · ${entry.caseCount} cases · ${entry.createdAt}`,
            }))
            .find((option) => option.value === (versionId ?? undefined)) ??
          ((versionId ?? undefined) == null || String(versionId ?? undefined) === ""
            ? null
            : {
                value: (versionId ?? undefined) as NonNullable<typeof versionId>,
                label: String(versionId ?? undefined),
              })
        }
        onChange={(_event, option) => {
          if (option !== null)
            ((id) => {
              setSelected(id);
              setCaseId(null);
              setSourceId(null);
            })(option.value as NonNullable<typeof versionId>);
        }}
        getOptionLabel={(option) => option.label}
        isOptionEqualToValue={(option, selected) => option.value === selected.value}
        getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
        renderInput={(params) => (
          <TextField
            {...params}
            label={"Published version"}
            placeholder={"No published versions"}
            slotProps={{
              ...params.slotProps,
              htmlInput: {
                ...params.slotProps.htmlInput,
                "aria-label": "Published version",
              },
            }}
          />
        )}
        disableClearable={Boolean(versionId ?? undefined)}
        getOptionKey={(option) => option.value}
      />
      {version.data ? (
        <DetailsGrid
          items={[
            {
              key: "revision",
              label: "Published from draft",
              value: `Revision ${version.data.sourceDraftRevision}`,
            },
            {
              key: "source",
              label: "Source manifest",
              value: <CopyValue value={version.data.sourceManifestSha256} />,
            },
            {
              key: "expected",
              label: "Expectation manifest",
              value: <CopyValue value={version.data.expectationManifestSha256} />,
            },
          ]}
          columns={1}
        />
      ) : null}
      <DataTable<C.EvaluationSuiteCaseSummaryV1>
        loading={active && !!versionId && cases.isPending}
        rows={cases.data?.items ?? []}
        getRowId={(row) => row.caseId}
        columns={[
          {
            id: "case",
            label: "Case",
            render: (entry) => {
              return (
                <div>
                  <Button
                    className="evaluation-name"
                    onClick={() => {
                      setCaseId(entry.caseId);
                      setSourceId(null);
                    }}
                    variant="text"
                  >
                    {entry.title}
                  </Button>
                  <CaseSourceLabel
                    sourceId={entry.sourceId}
                    known={sources.find((source) => source.id === entry.sourceId)}
                  />
                </div>
              );
            },
          },
          {
            id: "applicability",
            label: "Applicability",
            render: (entry) => {
              return (
                <Chip
                  label={
                    entry.applicability.state === "applicable" ? "Applicable" : "Not applicable"
                  }
                />
              );
            },
          },
          {
            id: "checks",
            label: "Checks",
            render: (row) => row.criterionCount,
          },
          {
            id: "labels",
            label: "Finding labels",
            render: (entry) => {
              return `${entry.annotation} · ${entry.expectedFindingCount}`;
            },
          },
        ]}
        ariaLabel="Evaluation records"
      />
      {detail.data ? (
        <Card variant="outlined">
          <CardHeader
            title={detail.data.expectation.title}
            slotProps={{
              title: {
                variant: "subtitle1",
                component: "h3",
              },
            }}
          />
          <CardContent>
            <FrozenSourceLabel source={detail.data.source} />
            <Stack
              direction="row"
              spacing={1.5}
              sx={{
                alignItems: "center",
                flexWrap: "wrap",
                gap: 1,
              }}
            >
              <Chip label={detail.data.expectation.findings.annotation} />
              <Button
                onClick={() => setSourceId(detail.data?.source.id ?? null)}
                variant="outlined"
              >
                View frozen body
              </Button>
            </Stack>
            {detail.data.expectation.applicability.state === "not_applicable" ? (
              <Alert severity={"info"}>
                <AlertTitle>{"Not applicable"}</AlertTitle>
                {detail.data.expectation.applicability.reason}
              </Alert>
            ) : null}
            <DataTable<C.EvaluationSuiteDraftCase["criteria"][number]>
              rows={detail.data.expectation.criteria}
              getRowId={(row) => row.criterionId}
              columns={[
                {
                  id: "description",
                  label: "Expected check",
                  render: (row) => row.description,
                },
                {
                  id: "outcome",
                  label: "Expected outcome",
                  render: (row) => row.expectedOutcome,
                },
                {
                  id: "scope",
                  label: "Scope",
                  render: (criterion) => {
                    return criterion.applicability.state === "applicable"
                      ? "Applicable"
                      : criterion.applicability.reason;
                  },
                },
              ]}
              ariaLabel="Evaluation records"
            />
            <Typography component="p" variant="body2">
              {detail.data.expectation.findings.annotation === "unlabeled"
                ? "Finding expectations are unlabeled. This is not a negative example."
                : detail.data.expectation.findings.expected.length === 0
                  ? detail.data.expectation.findings.annotation === "complete"
                    ? "Complete labels declare that no findings are expected."
                    : "No known positives are listed; other findings remain unassessed."
                  : detail.data.expectation.findings.annotation === "complete"
                    ? "Exhaustive expected findings:"
                    : "Known positive findings only:"}
            </Typography>
            {detail.data.expectation.findings.expected.length ? (
              <ul>
                {detail.data.expectation.findings.expected.map((finding) => (
                  <li key={finding.expectedFindingId}>
                    {finding.description}
                    <div className="evaluation-meta">{finding.expectedFindingId}</div>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {sourceId ? <SourceDetails sourceId={sourceId} onClose={() => setSourceId(null)} /> : null}
    </div>
  );
}
