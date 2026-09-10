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
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { DataTable } from "@/components/ui";
import type { EvaluationAdjudicationAdapter } from "@/services/evaluation-adjudication";
import {
  ReviewControlProtocolError,
  ReviewControlRequestError,
} from "@/services/review-control/errors";
import { useEvaluationPage, useEvaluationQuery } from "./context";
import { EvaluationTable } from "./Display";
import { errorMessage, newIdentity, OriginalMutation } from "./state";

type ContextItem = C.EvaluationAdjudicationContextV1["items"][number];
type Judgment = C.EvaluationAdjudicationChangeRequest["judgment"];
interface Editor {
  occurrenceKey: string;
  expectedVersion: number;
  judgment: Judgment;
  savedJson: string;
}
interface ChangeIntent {
  scope: C.EvaluationAdjudicationScope;
  request: C.EvaluationAdjudicationChangeRequest;
}
const kinds = [
  {
    value: "match",
    label: "Matches an expected finding",
  },
  {
    value: "duplicate",
    label: "Duplicate of a primary match",
  },
  {
    value: "false_positive",
    label: "False positive",
  },
  {
    value: "unjudged",
    label: "Unjudged",
  },
] as const;
export function resultAdjudicationScope(
  result: C.EvaluationCellResultV1,
): C.EvaluationCellResultReadQuery {
  return {
    repositoryId: result.repositoryId,
    evaluationId: result.evaluationId,
    cellId: result.cellId,
    resultId: result.resultId,
  };
}
export function assertAdjudicationContext(
  result: C.EvaluationCellResultV1,
  context: C.EvaluationAdjudicationContextV1,
): void {
  const scope = resultAdjudicationScope(result),
    occurrences = new Map(result.occurrences.map((item) => [item.key, item]));
  const expected = new Set(context.expectations.expected.map((item) => item.expectedFindingId)),
    matched = new Set<string>();
  const invalid = () => {
    throw new ReviewControlProtocolError(
      "read evaluation adjudications",
      "The adjudication context does not match this exact result and its complete occurrence set.",
    );
  };
  if (
    (Object.keys(scope) as (keyof typeof scope)[]).some(
      (key) => context.scope[key] !== scope[key],
    ) ||
    context.resultDigest !== result.resultDigest ||
    context.caseId !== result.caseId ||
    context.arm !== result.arm ||
    context.modelRequired !== result.modelRequirements.required ||
    context.modelState !== result.modelReview.state ||
    context.items.length !== result.occurrences.length ||
    new Set(context.items.map((item) => item.occurrence.key)).size !== result.occurrences.length
  )
    invalid();
  for (const item of context.items) {
    const occurrence = occurrences.get(item.occurrence.key);
    if (
      !occurrence ||
      occurrence.kind !== item.occurrence.kind ||
      occurrence.ordinal !== item.occurrence.ordinal ||
      occurrence.resultDigest !== item.occurrence.resultDigest ||
      occurrence.resultId !== item.occurrence.resultId
    )
      invalid();
    const adjudication = item.adjudication;
    if (adjudication?.kind === "match") {
      if (
        !expected.has(adjudication.expectedFindingId) ||
        matched.has(adjudication.expectedFindingId)
      )
        invalid();
      matched.add(adjudication.expectedFindingId);
    }
    if (
      adjudication?.kind === "duplicate" &&
      (adjudication.primaryOccurrenceKey === item.occurrence.key ||
        context.items.find(
          (candidate) => candidate.occurrence.key === adjudication.primaryOccurrenceKey,
        )?.adjudication?.kind !== "match")
    )
      invalid();
  }
}
export function judgmentFromCurrent(value: C.EvaluationFindingAdjudication | null): Judgment {
  if (!value)
    return {
      kind: "unjudged",
      reason: "",
    };
  if (value.kind === "match")
    return {
      kind: value.kind,
      expectedFindingId: value.expectedFindingId,
      reason: value.reason,
    };
  if (value.kind === "duplicate")
    return {
      kind: value.kind,
      primaryOccurrenceKey: value.primaryOccurrenceKey,
      reason: value.reason,
    };
  return {
    kind: value.kind,
    reason: value.reason,
  };
}
export function changeJudgmentKind(previous: Judgment, kind: Judgment["kind"]): Judgment {
  return kind === "match"
    ? {
        kind,
        expectedFindingId: "",
        reason: previous.reason,
      }
    : kind === "duplicate"
      ? {
          kind,
          primaryOccurrenceKey: "",
          reason: previous.reason,
        }
      : {
          kind,
          reason: previous.reason,
        };
}
export function adjudicationEditorForItem(item: ContextItem): Editor {
  const judgment = judgmentFromCurrent(item.adjudication);
  return {
    occurrenceKey: item.occurrence.key,
    expectedVersion: item.version,
    judgment,
    savedJson: JSON.stringify(judgment),
  };
}
export function applyReviewedAdjudicationVersion(
  editor: Editor,
  reviewed: {
    occurrenceKey: string;
    version: number;
  },
): Editor {
  if (editor.occurrenceKey !== reviewed.occurrenceKey)
    throw new ReviewControlRequestError(
      "change evaluation adjudication",
      "occurrenceKey",
      "The refreshed version belongs to another occurrence.",
    );
  return {
    ...editor,
    expectedVersion: reviewed.version,
  };
}
export function validateJudgmentIntent(
  context: C.EvaluationAdjudicationContextV1,
  key: string,
  judgment: Judgment,
): void {
  const reject = (message: string): never => {
    throw new ReviewControlRequestError("change evaluation adjudication", "judgment", message);
  };
  if (!context.modelRequired || context.modelState !== "completed")
    reject("Only a required, completed model result accepts adjudication changes.");
  const item = context.items.find((candidate) => candidate.occurrence.key === key);
  if (!item) reject("Select an occurrence in this exact result.");
  if (judgment.kind === "match") {
    if (
      !context.expectations.expected.some(
        (expected) => expected.expectedFindingId === judgment.expectedFindingId,
      )
    )
      reject("Select a frozen expected finding for this case.");
    if (
      context.items.some(
        (candidate) =>
          candidate.occurrence.key !== key &&
          candidate.adjudication?.kind === "match" &&
          candidate.adjudication.expectedFindingId === judgment.expectedFindingId,
      )
    )
      reject("Another primary match already uses this expected finding.");
  }
  if (
    judgment.kind === "duplicate" &&
    (judgment.primaryOccurrenceKey === key ||
      context.items.find((candidate) => candidate.occurrence.key === judgment.primaryOccurrenceKey)
        ?.adjudication?.kind !== "match")
  )
    reject("A duplicate must point directly to another current primary match in this result.");
  if (
    judgment.kind !== "match" &&
    context.items.some(
      (candidate) =>
        candidate.adjudication?.kind === "duplicate" &&
        candidate.adjudication.primaryOccurrenceKey === key,
    )
  )
    reject(
      "Resolve the existing duplicate references before changing this primary to a non-match.",
    );
}
function occurrenceContent(result: C.EvaluationCellResultV1, occurrence: C.FindingOccurrenceRef) {
  return occurrence.kind === "pr_finding"
    ? result.modelReview.findings[occurrence.ordinal]
    : result.modelReview.observations[occurrence.ordinal];
}
export function judgmentLabel(value: C.EvaluationFindingAdjudication | null): string {
  return !value
    ? "Not yet judged"
    : value.kind === "match"
      ? `Match · ${value.expectedFindingId}`
      : value.kind === "duplicate"
        ? `Duplicate · ${value.primaryOccurrenceKey.slice(0, 12)}`
        : value.kind === "false_positive"
          ? "False positive"
          : "Unjudged";
}
export function adjudicationEditingAllowed(
  context: C.EvaluationAdjudicationContextV1 | null,
  access: {
    active: boolean;
    readable: boolean;
    reviewer: boolean;
    fetching: boolean;
    error: unknown;
  },
): boolean {
  return (
    access.active &&
    access.readable &&
    access.reviewer &&
    context?.modelRequired === true &&
    context.modelState === "completed" &&
    !access.error &&
    !access.fetching
  );
}
export function Adjudication({
  result,
  adapter,
  active,
}: {
  result: C.EvaluationCellResultV1;
  adapter: EvaluationAdjudicationAdapter;
  active: boolean;
}) {
  const page = useEvaluationPage(),
    access = useOperatorAccess(page.repositoryId);
  const scope = resultAdjudicationScope(result),
    scopeKey = JSON.stringify([scope, result.resultDigest]);
  const contextQuery = useEvaluationQuery(
    ["adjudications", scopeKey],
    async (signal) => {
      const value = await adapter.getContext(scope, signal);
      assertAdjudicationContext(result, value);
      return value;
    },
    active,
  );
  const [retained, setRetained] = useState<C.EvaluationAdjudicationContextV1 | null>(null);
  useEffect(() => {
    if (contextQuery.data) setRetained(contextQuery.data);
  }, [contextQuery.data]);
  const context = contextQuery.data ?? retained;
  const [editor, setEditor] = useState<Editor | null>(null),
    [historyOpen, setHistoryOpen] = useState(false),
    [historyPage, setHistoryPage] = useState(1);
  const [reviewed, setReviewed] = useState<{
      occurrenceKey: string;
      version: number;
    } | null>(null),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const owner = useMemo(() => new OriginalMutation<ChangeIntent>(), []);
  const mutation = useSyncExternalStore(owner.subscribe, owner.snapshot, owner.snapshot);
  useEffect(() => {
    owner.activate();
    return () => owner.dispose();
  }, [owner]);
  const sameActor =
    access.principal?.issuer === page.principal.issuer &&
    access.principal?.subject === page.principal.subject;
  const reviewer =
    sameActor &&
    access.ready &&
    !access.checking &&
    !access.pending &&
    !access.error &&
    access.can("review");
  const canWrite = adjudicationEditingAllowed(context, {
    active,
    readable: page.readable,
    reviewer,
    error: contextQuery.error,
    fetching: contextQuery.isFetching,
  });
  const pending = mutation.busy || mutation.request !== null;
  const current = context?.items.find((item) => item.occurrence.key === editor?.occurrenceKey);
  const dirty = editor !== null && JSON.stringify(editor.judgment) !== editor.savedJson;
  const stale = !!editor && !!current && current.version > editor.expectedVersion;
  const currentVersionMatches = !!editor && current?.version === editor.expectedVersion;
  const conflict = mutation.conflict || stale;
  const select = (item: ContextItem, history = false) => {
    if (pending || (dirty && item.occurrence.key !== editor?.occurrenceKey)) return;
    if (item.occurrence.key !== editor?.occurrenceKey) {
      setEditor(adjudicationEditorForItem(item));
      setReviewed(null);
      setError(null);
      setNotice(null);
      owner.reset();
      setHistoryPage(1);
    }
    setHistoryOpen(history);
  };
  const execute = (intent: ChangeIntent) =>
    adapter.change(intent.scope, intent.request, page.principal).then((value) => {
      if (value.adjudication.caseId !== result.caseId || value.adjudication.arm !== result.arm)
        throw new ReviewControlProtocolError(
          "change evaluation adjudication",
          "The accepted judgment does not belong to this result's case and arm.",
        );
      return value;
    });
  const success = (value: C.EvaluationAdjudicationChangeV1) => {
    setEditor((previous) =>
      previous && previous.occurrenceKey === value.scope.occurrenceKey
        ? {
            ...previous,
            expectedVersion: value.version,
            savedJson: JSON.stringify(previous.judgment),
          }
        : previous,
    );
    setNotice(`Judgment saved at version ${value.version}.`);
    setReviewed(null);
    void contextQuery.refetch();
    if (historyOpen) void history.refetch();
  };
  const save = () => {
    if (
      !canWrite ||
      !editor ||
      !context ||
      pending ||
      conflict ||
      !dirty ||
      !currentVersionMatches ||
      editor.expectedVersion >= Number.MAX_SAFE_INTEGER
    )
      return;
    try {
      validateJudgmentIntent(context, editor.occurrenceKey, editor.judgment);
      const request = {
        changeId: newIdentity(),
        expectedVersion: editor.expectedVersion,
        resultDigest: result.resultDigest,
        judgment: editor.judgment,
      };
      const issues = C.getEvaluationAdjudicationChangeRequestIssues(request);
      if (issues.length)
        throw new ReviewControlRequestError(
          "change evaluation adjudication",
          "request",
          issues[0] ?? "Invalid judgment.",
        );
      setError(null);
      setNotice(null);
      void owner.run(
        {
          scope: {
            ...scope,
            occurrenceKey: editor.occurrenceKey,
          },
          request,
        },
        execute,
        success,
        page.invalidateAccess,
      );
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };
  const retry = () => {
    if (canWrite && mutation.request)
      void owner.run(mutation.request, execute, success, page.invalidateAccess);
  };
  const refresh = async () => {
    if (!active || !page.readable || pending) return;
    const selectedKey = editor?.occurrenceKey;
    const value = await contextQuery.refetch();
    if (!value.isError && value.data && selectedKey) {
      const item = value.data.items.find((candidate) => candidate.occurrence.key === selectedKey);
      if (item) {
        setReviewed({
          occurrenceKey: selectedKey,
          version: item.version,
        });
        setNotice("Current judgments refreshed. Your proposed judgment is unchanged.");
      }
    }
  };
  const history = useEvaluationQuery(
    ["adjudication-history", scopeKey, editor?.occurrenceKey, historyPage],
    async (signal) => {
      if (!editor) throw new Error("Select an occurrence first.");
      const value = await adapter.history(
        {
          ...scope,
          occurrenceKey: editor.occurrenceKey,
        },
        {
          page: historyPage,
          pageSize: 20,
        },
        signal,
      );
      if (
        value.resultDigest !== result.resultDigest ||
        value.items.some(
          (item) =>
            item.adjudication.caseId !== result.caseId || item.adjudication.arm !== result.arm,
        )
      )
        throw new ReviewControlProtocolError(
          "read evaluation adjudication history",
          "The history belongs to another result, case or arm.",
        );
      return value;
    },
    active && editor !== null && historyOpen,
  );
  const locked = !canWrite || pending;
  const reason =
    context === null
      ? "Load current judgments before editing."
      : !context.modelRequired
        ? "This profile-only result does not participate in model adjudication."
        : context.modelState !== "completed"
          ? "The required model result is not completed. Judgments are read-only."
          : !reviewer
            ? "Reviewer permission is required to change judgments."
            : null;
  const rows = result.occurrences.map((occurrence) => ({
    occurrence,
    item: context?.items.find((item) => item.occurrence.key === occurrence.key),
    content: occurrenceContent(result, occurrence),
  }));
  const selectedExpectedFindingId =
    editor?.judgment.kind === "match" ? editor.judgment.expectedFindingId : "";
  const selectedPrimaryOccurrenceKey =
    editor?.judgment.kind === "duplicate" ? editor.judgment.primaryOccurrenceKey : "";
  return (
    <Card variant="elevation" elevation={0} className="evaluation-section-card">
      <CardHeader
        title={"Human adjudication"}
        action={
          <Button
            disabled={!active || !page.readable || pending}
            loading={contextQuery.isFetching}
            onClick={() => void refresh()}
            variant="outlined"
          >
            Refresh judgments
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
        <Typography component="p" variant="body2" color={"text.secondary"}>
          Judge each model occurrence against this case's frozen expected findings. Evidence
          verification is separate; a judgment never approves a pull request.
        </Typography>
        {reason ? (
          <Alert severity={"info"}>
            <AlertTitle>{"Read-only adjudication"}</AlertTitle>
            {reason}
          </Alert>
        ) : null}
        {contextQuery.error ? (
          <Alert severity={"error"}>
            <AlertTitle>{"Adjudication context unavailable"}</AlertTitle>
            {errorMessage(contextQuery.error)}
          </Alert>
        ) : null}
        {context ? (
          <Card variant="elevation" elevation={0} className="evaluation-tonal-card">
            <CardHeader
              title={"Frozen expected findings"}
              action={<Chip label={context.expectations.annotation} />}
              slotProps={{
                title: {
                  variant: "subtitle1",
                  component: "h3",
                },
              }}
            />
            <CardContent>
              <Typography component="p" variant="body2">
                {context.expectations.annotation === "unlabeled"
                  ? "Finding expectations are unlabeled; an empty list is not a negative example."
                  : context.expectations.annotation === "partial"
                    ? "Only known positive findings are labeled. Other findings remain unassessed."
                    : context.expectations.expected.length === 0
                      ? "Complete labels explicitly declare that no findings are expected."
                      : "This list declares all expected findings for the frozen case."}
              </Typography>
              {context.expectations.expected.map((expected) => (
                <p key={expected.expectedFindingId}>
                  {expected.description}
                  <span className="evaluation-meta">{expected.expectedFindingId}</span>
                </p>
              ))}
            </CardContent>
          </Card>
        ) : null}
        <EvaluationTable
          loading={contextQuery.isPending}
          rows={context ? rows : []}
          getRowId={(row) => row.occurrence.key}
          columns={[
            {
              id: "occurrence",
              label: "Model occurrence",
              render: (row) => {
                return (
                  <div>
                    <strong>{row.content?.title}</strong>
                    <p className="evaluation-result-text">{row.content?.body}</p>
                    <span className="evaluation-meta">
                      {row.occurrence.kind} · ordinal {row.occurrence.ordinal} ·{" "}
                      {row.occurrence.key}
                    </span>
                  </div>
                );
              },
            },
            {
              id: "current",
              label: "Current judgment",
              render: (row) => {
                return (
                  <div>
                    {judgmentLabel(row.item?.adjudication ?? null)}
                    <span className="evaluation-meta">Version {row.item?.version ?? 0}</span>
                  </div>
                );
              },
            },
            {
              id: "actions",
              label: "Actions",
              render: (row) => {
                return row.item ? (
                  <Stack
                    direction="row"
                    spacing={1.5}
                    sx={{
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 1,
                    }}
                  >
                    <Button
                      disabled={pending || (dirty && row.occurrence.key !== editor?.occurrenceKey)}
                      onClick={() => row.item && select(row.item)}
                      variant="outlined"
                    >
                      Inspect judgment
                    </Button>
                    <Button
                      disabled={pending || (dirty && row.occurrence.key !== editor?.occurrenceKey)}
                      onClick={() => row.item && select(row.item, true)}
                      variant="outlined"
                    >
                      History
                    </Button>
                  </Stack>
                ) : null;
              },
            },
          ]}
          ariaLabel="Evaluation records"
          pageSize={10}
        />
        {editor && current && context ? (
          <Card variant="outlined">
            <CardHeader
              title={`Judgment · occurrence ${current.occurrence.ordinal}`}
              action={
                <Button
                  disabled={pending}
                  onClick={() => {
                    setEditor(null);
                    owner.reset();
                    setReviewed(null);
                    setHistoryOpen(false);
                  }}
                  variant="outlined"
                >
                  Discard editor
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
              <span className="evaluation-meta">
                {editor.occurrenceKey} · editing version {editor.expectedVersion} · current version{" "}
                {current.version}
              </span>
              {conflict ? (
                <Alert
                  action={
                    <Button
                      disabled={!active || !page.readable || pending}
                      onClick={() => void refresh()}
                      variant="outlined"
                    >
                      Refresh current judgment
                    </Button>
                  }
                  severity={"warning"}
                >
                  <AlertTitle>{"The current judgment changed"}</AlertTitle>
                  {
                    "Your proposed judgment and original version are preserved. Refresh current judgments to compare, then explicitly use the refreshed version before creating a new change."
                  }
                </Alert>
              ) : null}
              {conflict && reviewed?.occurrenceKey === editor.occurrenceKey ? (
                <Button
                  disabled={!canWrite || pending}
                  onClick={() => {
                    if (!canWrite || pending) return;
                    setEditor(applyReviewedAdjudicationVersion(editor, reviewed));
                    owner.reset();
                    setReviewed(null);
                  }}
                  variant="outlined"
                >
                  Use refreshed version {reviewed.version} for this intent
                </Button>
              ) : null}
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
                  options={[...kinds]}
                  disablePortal
                  fullWidth
                  disabled={locked}
                  value={
                    [...kinds].find((option) => option.value === editor.judgment.kind) ??
                    (editor.judgment.kind == null || String(editor.judgment.kind) === ""
                      ? null
                      : {
                          value: editor.judgment.kind as NonNullable<
                            NonNullable<NonNullable<typeof editor>["judgment"]>["kind"]
                          >,
                          label: String(editor.judgment.kind),
                        })
                  }
                  onChange={(_event, option) => {
                    if (option !== null)
                      ((kind) => {
                        if (!locked)
                          setEditor({
                            ...editor,
                            judgment: changeJudgmentKind(editor.judgment, kind),
                          });
                      })(
                        option.value as NonNullable<
                          NonNullable<NonNullable<typeof editor>["judgment"]>["kind"]
                        >,
                      );
                  }}
                  getOptionLabel={(option) => option.label}
                  isOptionEqualToValue={(option, selected) => option.value === selected.value}
                  getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label={"Judgment"}
                      slotProps={{
                        ...params.slotProps,
                        htmlInput: {
                          ...params.slotProps.htmlInput,
                          "aria-label": "Evaluation finding judgment",
                        },
                      }}
                    />
                  )}
                  disableClearable={Boolean(editor.judgment.kind)}
                  getOptionKey={(option) => option.value}
                />
                {editor.judgment.kind === "match" ? (
                  <Autocomplete
                    options={context.expectations.expected.map((expected) => ({
                      value: expected.expectedFindingId,
                      label: expected.description,
                      disabled: context.items.some(
                        (item) =>
                          item.occurrence.key !== editor.occurrenceKey &&
                          item.adjudication?.kind === "match" &&
                          item.adjudication.expectedFindingId === expected.expectedFindingId,
                      ),
                    }))}
                    disablePortal
                    fullWidth
                    disabled={locked}
                    value={
                      context.expectations.expected
                        .map((expected) => ({
                          value: expected.expectedFindingId,
                          label: expected.description,
                          disabled: context.items.some(
                            (item) =>
                              item.occurrence.key !== editor.occurrenceKey &&
                              item.adjudication?.kind === "match" &&
                              item.adjudication.expectedFindingId === expected.expectedFindingId,
                          ),
                        }))
                        .find(
                          (option) => option.value === (selectedExpectedFindingId || undefined),
                        ) ??
                      ((selectedExpectedFindingId || undefined) == null ||
                      String(selectedExpectedFindingId || undefined) === ""
                        ? null
                        : {
                            value: (selectedExpectedFindingId || undefined) as NonNullable<string>,
                            label: String(selectedExpectedFindingId || undefined),
                            disabled: false,
                          })
                    }
                    onChange={(_event, option) => {
                      if (option !== null)
                        ((expectedFindingId) => {
                          if (!locked)
                            setEditor({
                              ...editor,
                              judgment: {
                                kind: "match",
                                expectedFindingId,
                                reason: editor.judgment.reason,
                              },
                            });
                        })(option.value as NonNullable<string>);
                    }}
                    getOptionLabel={(option) => option.label}
                    isOptionEqualToValue={(option, selected) => option.value === selected.value}
                    getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label={"Frozen expected finding"}
                        placeholder={"Select a frozen expectation"}
                        required
                        slotProps={{
                          ...params.slotProps,
                          htmlInput: {
                            ...params.slotProps.htmlInput,
                            "aria-label": "Matched frozen expected finding",
                          },
                        }}
                      />
                    )}
                    disableClearable={Boolean(selectedExpectedFindingId || undefined)}
                    getOptionKey={(option) => option.value}
                  />
                ) : editor.judgment.kind === "duplicate" ? (
                  <Autocomplete
                    options={context.items
                      .filter(
                        (item) =>
                          item.occurrence.key !== editor.occurrenceKey &&
                          item.adjudication?.kind === "match",
                      )
                      .map((item) => ({
                        value: item.occurrence.key,
                        label: `${occurrenceContent(result, item.occurrence)?.title ?? item.occurrence.kind} · ordinal ${item.occurrence.ordinal}`,
                      }))}
                    disablePortal
                    fullWidth
                    disabled={locked}
                    value={
                      context.items
                        .filter(
                          (item) =>
                            item.occurrence.key !== editor.occurrenceKey &&
                            item.adjudication?.kind === "match",
                        )
                        .map((item) => ({
                          value: item.occurrence.key,
                          label: `${occurrenceContent(result, item.occurrence)?.title ?? item.occurrence.kind} · ordinal ${item.occurrence.ordinal}`,
                        }))
                        .find(
                          (option) => option.value === (selectedPrimaryOccurrenceKey || undefined),
                        ) ??
                      ((selectedPrimaryOccurrenceKey || undefined) == null ||
                      String(selectedPrimaryOccurrenceKey || undefined) === ""
                        ? null
                        : {
                            value: (selectedPrimaryOccurrenceKey ||
                              undefined) as NonNullable<string>,
                            label: String(selectedPrimaryOccurrenceKey || undefined),
                          })
                    }
                    onChange={(_event, option) => {
                      if (option !== null)
                        ((primaryOccurrenceKey) => {
                          if (!locked)
                            setEditor({
                              ...editor,
                              judgment: {
                                kind: "duplicate",
                                primaryOccurrenceKey,
                                reason: editor.judgment.reason,
                              },
                            });
                        })(option.value as NonNullable<string>);
                    }}
                    getOptionLabel={(option) => option.label}
                    isOptionEqualToValue={(option, selected) => option.value === selected.value}
                    getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label={"Primary match"}
                        placeholder={"Select a current primary match"}
                        required
                        slotProps={{
                          ...params.slotProps,
                          htmlInput: {
                            ...params.slotProps.htmlInput,
                            "aria-label": "Duplicate primary occurrence",
                          },
                        }}
                      />
                    )}
                    disableClearable={Boolean(selectedPrimaryOccurrenceKey || undefined)}
                    getOptionKey={(option) => option.value}
                  />
                ) : null}
                <TextField
                  value={editor.judgment.reason}
                  onChange={(event) => {
                    if (!locked)
                      setEditor({
                        ...editor,
                        judgment: {
                          ...editor.judgment,
                          reason: event.target.value,
                        },
                      });
                  }}
                  fullWidth
                  label={"Reason"}
                  required={true}
                  disabled={locked}
                  slotProps={{
                    htmlInput: {
                      maxLength: 2048,
                      "aria-label": "Adjudication reason",
                    },
                  }}
                  multiline
                  minRows={2}
                  maxRows={5}
                />
              </Stack>
              {error ? (
                <Alert severity={"error"}>
                  <AlertTitle>{"Review the proposed judgment"}</AlertTitle>
                  {error}
                </Alert>
              ) : null}
              {mutation.error ? (
                <Alert
                  action={
                    mutation.request ? (
                      <Button
                        disabled={!canWrite}
                        loading={mutation.busy}
                        onClick={retry}
                        variant="outlined"
                      >
                        Retry original judgment
                      </Button>
                    ) : undefined
                  }
                  severity={mutation.conflict ? "warning" : "error"}
                >
                  <AlertTitle>
                    {mutation.request ? "The result is not confirmed" : "The judgment was rejected"}
                  </AlertTitle>
                  {mutation.error}
                </Alert>
              ) : null}
              {mutation.request ? (
                <p className="evaluation-meta">
                  The exact occurrence, change ID, expected version and judgment are preserved for
                  retry.
                </p>
              ) : null}
              {notice ? (
                <Alert severity={"info"}>
                  <AlertTitle>{notice}</AlertTitle>
                </Alert>
              ) : null}
              {editor.expectedVersion >= Number.MAX_SAFE_INTEGER ? (
                <Alert severity={"info"}>
                  <AlertTitle>{"The judgment version limit has been reached"}</AlertTitle>
                </Alert>
              ) : null}
              <Stack
                direction="row"
                spacing={1.5}
                sx={{
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 1,
                }}
              >
                <Button
                  disabled={
                    locked ||
                    conflict ||
                    !dirty ||
                    !currentVersionMatches ||
                    editor.expectedVersion >= Number.MAX_SAFE_INTEGER
                  }
                  loading={mutation.busy}
                  onClick={save}
                  variant="contained"
                >
                  Save judgment
                </Button>
                <Button onClick={() => setHistoryOpen((value) => !value)} variant="outlined">
                  {historyOpen ? "Hide history" : "Show history"}
                </Button>
              </Stack>
              {historyOpen ? (
                <>
                  {history.error ? (
                    <Alert severity={"error"}>
                      <AlertTitle>{"History unavailable"}</AlertTitle>
                      {errorMessage(history.error)}
                    </Alert>
                  ) : null}
                  <DataTable
                    loading={history.isFetching}
                    rows={history.data?.items ?? []}
                    getRowId={(item) => item.adjudication.adjudicationId}
                    columns={[
                      {
                        id: "version",
                        label: "Version",
                        render: (row) => row.version,
                      },
                      {
                        id: "judgment",
                        label: "Judgment",
                        render: (item) => {
                          return (
                            <div>
                              {judgmentLabel(item.adjudication)}
                              <p>{item.adjudication.reason}</p>
                            </div>
                          );
                        },
                      },
                      {
                        id: "actor",
                        label: "Reviewer",
                        render: (item) => {
                          return (
                            <span className="evaluation-meta">
                              {item.adjudication.actor.issuer} · {item.adjudication.actor.subject}
                              <br />
                              {item.adjudication.createdAt}
                            </span>
                          );
                        },
                      },
                    ]}
                    ariaLabel="Evaluation records"
                    pagination={{
                      page: historyPage,
                      pageSize: 20,
                      total: history.data?.total ?? 0,
                      onChange: setHistoryPage,
                    }}
                  />
                </>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </CardContent>
    </Card>
  );
}
