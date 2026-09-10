import * as C from "@agentic-review/contracts";
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Pagination,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { DetailsGrid } from "@/components/ui";
import { reviewControl } from "@/services/review-control";
import type { WorkItem } from "@/services/review-control/types";
import {
  MutationNotice,
  useEvaluationPage,
  useEvaluationQuery,
  useOriginalMutation,
  useRefreshEvaluations,
} from "./context";
import { CopyValue, EvaluationTable } from "./Display";
import { errorMessage, newIdentity, type SampleKind } from "./state";
export function FrozenSourceLabel({ source }: { source: C.EvaluationSourceSummaryV1 }) {
  return (
    <div className="evaluation-source-signature">
      <Stack
        direction="row"
        spacing={1.5}
        sx={{
          alignItems: "center",
          flexWrap: "wrap",
          gap: 1,
        }}
      >
        <Chip
          label={
            <>
              {source.workItemKind === "pull_request" ? "PR" : "Issue"} #{source.number}
            </>
          }
        />
        <Typography
          component="span"
          variant="body2"
          sx={{
            fontWeight: 500,
          }}
        >
          {source.title}
        </Typography>
      </Stack>
      <span className="evaluation-meta" title={source.revisionKey}>
        Frozen revision {source.revisionKey.slice(0, 12)} · {source.id}
      </span>
    </div>
  );
}
export function CaseSourceLabel({
  sourceId,
  known,
}: {
  sourceId: string;
  known?: C.EvaluationSourceSummaryV1;
}) {
  const page = useEvaluationPage();
  const query = useEvaluationQuery(
    ["source", sourceId],
    (signal) =>
      page.api.getSource(
        {
          repositoryId: page.repositoryId,
          sourceId,
        },
        signal,
      ),
    !known,
  );
  const source = known ?? query.data;
  return source ? (
    <FrozenSourceLabel source={source} />
  ) : (
    <Typography
      component="span"
      variant="body2"
      color={query.isError ? "error.main" : "text.secondary"}
    >
      {query.isError ? "Frozen source unavailable" : "Loading frozen source…"} · {sourceId}
    </Typography>
  );
}
export function SourceDetails({ sourceId, onClose }: { sourceId: string; onClose: () => void }) {
  const page = useEvaluationPage();
  const query = useEvaluationQuery(["source", sourceId], (signal) =>
    page.api.getSource(
      {
        repositoryId: page.repositoryId,
        sourceId,
      },
      signal,
    ),
  );
  const source = query.data;
  return (
    <Card variant="outlined">
      <CardHeader
        title={"Captured source"}
        action={
          <Button onClick={onClose} variant="outlined">
            Close source
          </Button>
        }
        slotProps={{
          title: {
            variant: "subtitle1",
            component: "h3",
          },
        }}
      />
      {query.isPending ? (
        <CardContent>
          <Skeleton variant="rounded" height={120} aria-label="Loading source details" />
        </CardContent>
      ) : (
        <CardContent>
          {query.error ? (
            <Alert severity={"error"}>
              <AlertTitle>{"Source unavailable"}</AlertTitle>
              {errorMessage(query.error)}
            </Alert>
          ) : source ? (
            <>
              <FrozenSourceLabel source={source} />
              <DetailsGrid
                items={[
                  {
                    key: "captured",
                    label: "Captured",
                    value: source.createdAt,
                  },
                  {
                    key: "digest",
                    label: "Source digest",
                    value: <CopyValue value={source.sourceDigest} />,
                  },
                  {
                    key: "commit",
                    label: "Checkout",
                    value: source.snapshot.testedSourceRevision
                      ? source.snapshot.testedSourceRevision.headSha
                      : "Snapshot only",
                  },
                  {
                    key: "origin",
                    label: "Original item",
                    value: (
                      <a href={source.snapshot.workItem.htmlUrl} target="_blank" rel="noreferrer">
                        Open {source.workItemKind === "pull_request" ? "pull request" : "issue"} #
                        {source.number}
                      </a>
                    ),
                  },
                ]}
                columns={1}
              />
              <Typography
                component="span"
                variant="body2"
                sx={{
                  fontWeight: 500,
                }}
              >
                Frozen body
              </Typography>
              <pre className="evaluation-source-body">
                {source.snapshot.workItem.body ?? "No body was provided."}
              </pre>
            </>
          ) : null}
        </CardContent>
      )}
    </Card>
  );
}
function SourceCapture({ kind, active }: { kind: SampleKind; active: boolean }) {
  const page = useEvaluationPage(),
    refresh = useRefreshEvaluations();
  const [method, setMethod] = useState<"current_work_item" | "review_run">("current_work_item");
  const [search, setSearch] = useState(""),
    [itemPage, setItemPage] = useState(1);
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [commit, setCommit] = useState(""),
    [runId, setRunId] = useState(""),
    [planDigest, setPlanDigest] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [captured, setCaptured] = useState<C.EvaluationSourceSummaryV1 | null>(null);
  const workItems = useEvaluationQuery(
    ["capture-items", kind, search, itemPage],
    async () => {
      const result = await reviewControl.listWorkItems({
        page: itemPage,
        pageSize: 20,
        search,
        filters: {
          repositoryId: page.repositoryId,
          kind,
        },
      });
      if (
        result.items.some((item) => item.repositoryId !== page.repositoryId || item.kind !== kind)
      )
        throw new Error("The work-item list does not match this repository and item kind.");
      return result;
    },
    active && method === "current_work_item",
  );
  const mutation = useOriginalMutation<
    C.EvaluationSourceCaptureRequest,
    C.EvaluationSourceSummaryV1
  >(
    (request) => page.api.captureSource(page.repositoryId, request, page.principal),
    (result) => {
      setCaptured(result);
      refresh();
    },
  );
  const locked = !page.canConfigure || mutation.busy || mutation.request !== null;
  const capture = () => {
    if (locked) return;
    setValidationError(null);
    const request: C.EvaluationSourceCaptureRequest = {
      changeId: newIdentity(),
      source:
        method === "review_run"
          ? {
              kind: method,
              reviewRunId: runId,
              expectedPlanDigest: planDigest,
            }
          : {
              kind: method,
              workItemId: selected?.id ?? "",
              expectedRevisionKey: selected?.revisionKey ?? "",
              testedIssueCommit: kind === "issue" && commit !== "" ? commit : null,
            },
    };
    const issues = C.getEvaluationSourceCaptureRequestIssues(request);
    if (issues.length) {
      setValidationError(
        "Select a stored item and its revision, or enter a valid review run ID and plan digest. Commit IDs must be full lowercase hashes.",
      );
      return;
    }
    mutation.submit(request);
  };
  return (
    <Card variant="outlined">
      <CardHeader
        title={`Capture ${kind === "pull_request" ? "PR" : "Issue"} source`}
        slotProps={{
          title: {
            variant: "subtitle1",
            component: "h3",
          },
        }}
      />
      <CardContent>
        <Stack
          disabled={locked}
          component="fieldset"
          spacing={2}
          sx={{
            border: 0,
            p: 0,
            m: 0,
            minWidth: 0,
          }}
        >
          <Autocomplete
            options={[
              {
                value: "current_work_item",
                label: "Current stored work item",
              },
              {
                value: "review_run",
                label: "Immutable review run",
              },
            ]}
            disablePortal
            fullWidth
            disabled={locked}
            value={
              [
                {
                  value: "current_work_item",
                  label: "Current stored work item",
                },
                {
                  value: "review_run",
                  label: "Immutable review run",
                },
              ].find((option) => option.value === method) ??
              (method == null || String(method) === ""
                ? null
                : {
                    value: method as NonNullable<typeof method>,
                    label: String(method),
                  })
            }
            onChange={(_event, option) => {
              if (option !== null) setMethod(option.value as NonNullable<typeof method>);
            }}
            getOptionLabel={(option) => option.label}
            isOptionEqualToValue={(option, selected) => option.value === selected.value}
            getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
            renderInput={(params) => (
              <TextField
                {...params}
                label={"Capture from"}
                slotProps={{
                  ...params.slotProps,
                  htmlInput: {
                    ...params.slotProps.htmlInput,
                    "aria-label": "Capture from",
                  },
                }}
              />
            )}
            disableClearable={Boolean(method)}
            getOptionKey={(option) => option.value}
          />
          {method === "current_work_item" ? (
            <>
              <TextField
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setItemPage(1);
                }}
                placeholder="Search by title or number"
                fullWidth
                label={"Find a stored item"}
                disabled={locked}
                type="search"
              />
              {workItems.error ? (
                <Alert severity={"error"}>
                  <AlertTitle>{"Stored items unavailable"}</AlertTitle>
                  {errorMessage(workItems.error)}
                </Alert>
              ) : null}
              <Autocomplete
                loading={workItems.isFetching}
                options={(workItems.data?.items ?? []).map((item) => ({
                  value: item.id,
                  label: `#${item.number} ${item.title}`,
                }))}
                disablePortal
                fullWidth
                disabled={locked}
                value={
                  (workItems.data?.items ?? [])
                    .map((item) => ({
                      value: item.id,
                      label: `#${item.number} ${item.title}`,
                    }))
                    .find((option) => option.value === selected?.id) ??
                  (selected?.id == null || String(selected?.id) === ""
                    ? null
                    : {
                        value: selected?.id as NonNullable<NonNullable<typeof selected>["id"]>,
                        label: String(selected?.id),
                      })
                }
                onChange={(_event, option) => {
                  if (option !== null)
                    ((id) => {
                      const item = workItems.data?.items.find((value) => value.id === id);
                      if (item) setSelected(structuredClone(item));
                    })(option.value as NonNullable<NonNullable<typeof selected>["id"]>);
                }}
                getOptionLabel={(option) => option.label}
                isOptionEqualToValue={(option, selected) => option.value === selected.value}
                getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label={kind === "pull_request" ? "Pull request revision" : "Issue revision"}
                    placeholder={"Select a stored item"}
                    required
                    slotProps={{
                      ...params.slotProps,
                      htmlInput: {
                        ...params.slotProps.htmlInput,
                        "aria-label":
                          kind === "pull_request" ? "Pull request revision" : "Issue revision",
                      },
                    }}
                  />
                )}
                disableClearable={Boolean(selected?.id)}
                getOptionKey={(option) => option.value}
              />
              <Pagination
                disabled={locked}
                page={itemPage}
                count={Math.max(1, Math.ceil((workItems.data?.total ?? 0) / 20))}
                onChange={(_event, page) => setItemPage(page)}
              />
              {selected ? (
                <p className="evaluation-meta">
                  Selected #{selected.number} · revision {selected.revisionKey.slice(0, 12)}.
                  Capture checks this exact revision.
                </p>
              ) : null}
              {kind === "issue" ? (
                <TextField
                  value={commit}
                  onChange={(event) => setCommit(event.target.value)}
                  placeholder="Full 40- or 64-character commit hash"
                  fullWidth
                  label={"Issue checkout commit"}
                  helperText={
                    "Leave empty for triage. Issue validation requires an explicit commit."
                  }
                  disabled={locked}
                />
              ) : null}
            </>
          ) : (
            <>
              <TextField
                value={runId}
                onChange={(event) => setRunId(event.target.value)}
                fullWidth
                label={"Review run ID"}
                required={true}
                disabled={locked}
              />
              <TextField
                value={planDigest}
                onChange={(event) => setPlanDigest(event.target.value)}
                fullWidth
                label={"Original plan digest"}
                required={true}
                helperText={
                  "Copy the digest from the stored review run. Capture uses that run's original snapshot."
                }
                disabled={locked}
              />
            </>
          )}
        </Stack>
        {validationError ? (
          <Alert severity={"error"}>
            <AlertTitle>{validationError}</AlertTitle>
          </Alert>
        ) : null}
        <MutationNotice mutation={mutation} />
        {captured ? (
          <Alert severity={"success"}>
            <AlertTitle>{`Captured ${captured.workItemKind === "pull_request" ? "PR" : "Issue"} #${captured.number}`}</AlertTitle>
            {"The frozen source is now available in its item-kind tab."}
          </Alert>
        ) : null}
        <Button disabled={locked} loading={mutation.busy} onClick={capture} variant="contained">
          Capture source
        </Button>
      </CardContent>
    </Card>
  );
}
export function SourceLibrary({
  kind,
  sources,
  onAdd,
  allowAdd,
}: {
  kind: SampleKind;
  sources: C.EvaluationSourceSummaryV1[];
  onAdd?: (source: C.EvaluationSourceSummaryV1) => void;
  allowAdd: boolean;
}) {
  const page = useEvaluationPage();
  const [captureOpen, setCaptureOpen] = useState(false),
    [captureVisited, setCaptureVisited] = useState(false),
    [selected, setSelected] = useState<string | null>(null);
  return (
    <section
      className="evaluation-sources"
      aria-label={`${kind === "pull_request" ? "PR" : "Issue"} frozen sources`}
    >
      <Card variant="outlined">
        <CardHeader
          title={"Frozen sources"}
          action={
            page.allowsConfigure ? (
              <Button
                disabled={!page.canConfigure}
                onClick={() => {
                  setCaptureVisited(true);
                  setCaptureOpen((value) => !value);
                }}
                variant="outlined"
              >
                {captureOpen ? "Hide capture form" : "Capture source"}
              </Button>
            ) : null
          }
          slotProps={{
            title: {
              variant: "subtitle1",
              component: "h3",
            },
          }}
        />
        <CardContent>
          <Typography component="p" variant="body2" color={"text.secondary"}>
            Capture stored work before adding it to a sample set. Every case keeps its selected
            revision.
          </Typography>
          <EvaluationTable<C.EvaluationSourceSummaryV1>
            rows={sources}
            getRowId={(row) => row.id}
            columns={[
              {
                id: "source",
                label: "Source and frozen revision",
                render: (source) => {
                  return <FrozenSourceLabel source={source} />;
                },
              },
              {
                id: "actions",
                label: "Actions",
                width: 200,
                render: (source) => {
                  return (
                    <Stack
                      direction="row"
                      spacing={1.5}
                      sx={{
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: 1,
                      }}
                    >
                      <Button onClick={() => setSelected(source.id)} variant="outlined">
                        View source
                      </Button>
                      {onAdd && page.allowsConfigure ? (
                        <Button
                          disabled={!allowAdd || !page.canConfigure}
                          onClick={() => onAdd(source)}
                          variant="outlined"
                        >
                          Add case
                        </Button>
                      ) : null}
                    </Stack>
                  );
                },
              },
            ]}
            ariaLabel="Evaluation records"
            emptyTitle={`No frozen ${kind === "pull_request" ? "PR" : "Issue"} sources yet.`}
            pageSize={10}
          />
        </CardContent>
      </Card>
      {captureVisited ? (
        <div hidden={!captureOpen}>
          <SourceCapture kind={kind} active={captureOpen} />
        </div>
      ) : null}
      {selected ? <SourceDetails sourceId={selected} onClose={() => setSelected(null)} /> : null}
    </section>
  );
}
