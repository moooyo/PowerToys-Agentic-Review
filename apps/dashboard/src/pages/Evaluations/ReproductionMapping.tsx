import type * as C from "@agentic-review/contracts";
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  getObservationOptions,
  getPreconditionChecks,
  observationRefKey,
  reproductionProfileUnavailableReason,
} from "@/components/CreateReviewRun/reproduction";
import { observationRefLabel, observationValueLabel } from "@/components/IssueReproduction/state";
import { DataTable } from "@/components/ui";
import type { EvaluationReproductionAdapter } from "@/services/evaluation-reproduction";
import { type Arm, armLabels, arms } from "./batch-state";
import { ReproductionPreview } from "./ReproductionPreview";
import {
  buildReproductionSelections,
  emptyReproductionArm,
  type ReproductionDraft,
  type ReproductionDrafts,
  type ReproductionSources,
  reproductionDraft,
  reproductionPreviewRequest,
  reproductionRequirements,
  unmappedObservation,
  withoutReproductionPreview,
} from "./reproduction-state";
import { FrozenSourceLabel } from "./Sources";

function Signature({
  title,
  signature,
}: {
  title: string;
  signature: C.ObservationSignature | null;
}) {
  return (
    <div>
      <Typography
        component="span"
        variant="body2"
        sx={{
          fontWeight: 500,
        }}
      >
        {title}
      </Typography>
      {signature ? (
        <ul>
          {signature.allOf.map((predicate) => (
            <li
              key={JSON.stringify([
                observationRefKey(predicate.observation),
                predicate.equals.type,
                predicate.equals.value,
              ])}
            >
              {observationRefLabel(predicate.observation)} equals{" "}
              <Typography
                component="code"
                variant="body2"
                sx={{
                  fontFamily: '"Roboto Mono", monospace',
                }}
              >
                {observationValueLabel(predicate.equals)}
              </Typography>
            </li>
          ))}
        </ul>
      ) : (
        <p>No absent signature was recorded. Missing observations cannot establish absence.</p>
      )}
    </div>
  );
}
export function OriginalReproductionCase({ value }: { value: C.FrozenIssueReproductionCase }) {
  return (
    <Card variant="elevation" elevation={0} className="evaluation-tonal-card">
      <CardHeader
        title={value.id}
        slotProps={{
          title: {
            variant: "subtitle1",
            component: "h3",
          },
        }}
      />
      <CardContent>
        <Typography component="p" variant="body2">
          {value.context}
        </Typography>
        <span className="evaluation-meta">
          Original profile {value.profileVersionId} · {value.target}
        </span>
        <Typography
          component="span"
          variant="body2"
          sx={{
            fontWeight: 500,
          }}
        >
          Required preconditions
        </Typography>
        {value.preconditions.length ? (
          <ul>
            {value.preconditions.map((control) => (
              <li
                key={
                  control.kind === "check_passed"
                    ? JSON.stringify([control.kind, control.checkId])
                    : JSON.stringify([
                        control.kind,
                        observationRefKey(control.predicate.observation),
                        control.predicate.equals.type,
                        control.predicate.equals.value,
                      ])
                }
              >
                {control.kind === "check_passed" ? (
                  `Check passes: ${control.checkId}`
                ) : (
                  <>
                    {observationRefLabel(control.predicate.observation)} equals{" "}
                    <Typography
                      component="code"
                      variant="body2"
                      sx={{
                        fontFamily: '"Roboto Mono", monospace',
                      }}
                    >
                      {observationValueLabel(control.predicate.equals)}
                    </Typography>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>No original preconditions.</p>
        )}
        <Signature
          title="Issue present when every observation matches"
          signature={value.presentWhen}
        />
        <Signature
          title="Issue absent when every observation matches"
          signature={value.absentWhen}
        />
      </CardContent>
    </Card>
  );
}
function SourceMapping({
  api,
  entry,
  read,
  value,
  profiles,
  locked,
  onChange,
}: {
  api: EvaluationReproductionAdapter;
  entry: C.EvaluationSuiteCaseDetailV1;
  read: C.EvaluationReproductionSourceDefinitionReadV1;
  value: ReproductionDraft | undefined;
  profiles: Partial<Record<Arm, C.ValidationProfileVersion>>;
  locked: boolean;
  onChange: (value: ReproductionDraft) => void;
}) {
  const definition = read.sourceDefinition;
  if (!definition || !read.sourceDefinitionSha256)
    return (
      <Card variant="outlined">
        <CardHeader
          title={entry.expectation.title}
          slotProps={{
            title: {
              variant: "subtitle1",
              component: "h3",
            },
          }}
        />
        <CardContent>
          <FrozenSourceLabel source={entry.source} />
          <Typography component="p" variant="body2" color={"text.secondary"}>
            This source has no frozen reproduction definition. No observation mapping will be
            inferred from its scoring labels.
          </Typography>
        </CardContent>
      </Card>
    );
  const draft = reproductionDraft(value, read.sourceDefinitionSha256);
  const selected = definition.binding.cases.filter((original) =>
    draft.selectedCaseIds.includes(original.id),
  );
  const required = reproductionRequirements(selected);
  const completeProfiles =
    profiles.baseline && profiles.candidate
      ? {
          baseline: profiles.baseline,
          candidate: profiles.candidate,
        }
      : null;
  let previewRequest: C.EvaluationReproductionPreviewRequest | null = null;
  if (completeProfiles) {
    try {
      const selection = buildReproductionSelections({
        cases: [entry],
        sources: {
          [entry.source.id]: read,
        },
        drafts: {
          [entry.caseId]: draft,
        },
        profiles: completeProfiles,
      })[0];
      if (selection)
        previewRequest = reproductionPreviewRequest(entry.source.id, selection, completeProfiles);
    } catch {
      /* Incomplete explicit choices keep the preview unavailable. */
    }
  }
  const change = (arm: Arm, kind: "observations" | "checks", key: string, next: string) => {
    if (locked) return;
    onChange({
      ...withoutReproductionPreview(draft),
      [arm]: {
        ...draft[arm],
        [kind]: {
          ...draft[arm][kind],
          [key]: next === unmappedObservation ? null : next,
        },
      },
    });
  };
  return (
    <Card variant="outlined">
      <CardHeader
        title={entry.expectation.title}
        slotProps={{
          title: {
            variant: "subtitle1",
            component: "h3",
          },
        }}
      />
      <CardContent>
        <FrozenSourceLabel source={entry.source} />
        <Typography
          component="p"
          variant="body2"
          sx={{
            fontWeight: 500,
          }}
        >
          {definition.binding.claim}
        </Typography>
        <span className="evaluation-meta">
          Original run {definition.reviewRunId} · frozen source {definition.sourceId}
        </span>
        <Stack
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
            disabled={locked}
            options={definition.binding.cases.map((original) => ({
              value: original.id,
              label: `${original.id} · ${original.context}`,
            }))}
            disablePortal
            fullWidth
            multiple
            value={draft.selectedCaseIds.map(
              (selectedValue) =>
                definition.binding.cases
                  .map((original) => ({
                    value: original.id,
                    label: `${original.id} · ${original.context}`,
                  }))
                  .find((option) => option.value === selectedValue) ?? {
                  value: selectedValue,
                  label: String(selectedValue),
                },
            )}
            onChange={(_event, options) =>
              ((selectedCaseIds: string[]) => {
                if (!locked)
                  onChange({
                    ...withoutReproductionPreview(draft),
                    selectedCaseIds,
                    baseline: emptyReproductionArm(),
                    candidate: emptyReproductionArm(),
                  });
              })(options.map((option) => option.value))
            }
            getOptionLabel={(option) => option.label}
            isOptionEqualToValue={(option, selected) => option.value === selected.value}
            getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
            renderInput={(params) => (
              <TextField
                {...params}
                label={"Original reproduction cases"}
                placeholder={"Explicitly select original cases to reproduce"}
                required
                slotProps={{
                  ...params.slotProps,
                  htmlInput: {
                    ...params.slotProps.htmlInput,
                    "aria-label": `Original reproduction cases for ${entry.caseId}`,
                  },
                }}
              />
            )}
            getOptionKey={(option) => option.value}
          />
        </Stack>
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
          {definition.binding.cases.map((original) => (
            <div key={original.id}>
              <Chip
                label={
                  draft.selectedCaseIds.includes(original.id)
                    ? "Selected for both arms"
                    : "Not selected"
                }
              />
              <OriginalReproductionCase value={original} />
            </div>
          ))}
        </Stack>
        {selected.length ? (
          <div
            className="evaluation-arm-grid"
            style={{
              marginTop: 16,
            }}
          >
            {arms.map((arm) => {
              const profile = profiles[arm];
              const reason = profile
                ? reproductionProfileUnavailableReason(profile)
                : "Select the exact published profile before choosing this arm's observations.";
              const observations = profile && !reason ? getObservationOptions(profile) : [];
              const checks = profile && !reason ? getPreconditionChecks(profile) : [];
              const values = [
                ...required.observations.map((original) => draft[arm].observations[original.key]),
                ...required.checks.map((key) => draft[arm].checks[key]),
              ];
              const hasUnmapped = values.some((choice) => choice === null);
              const missing = values.filter((choice) => choice === undefined).length;
              return (
                <Card key={arm} variant="elevation" elevation={0} className="evaluation-tonal-card">
                  <CardHeader
                    title={`${armLabels[arm]} reproduction mapping`}
                    slotProps={{
                      title: {
                        variant: "subtitle1",
                        component: "h3",
                      },
                    }}
                  />
                  <CardContent>
                    {reason ? (
                      <Alert severity={"warning"}>
                        <AlertTitle>{"Observations unavailable"}</AlertTitle>
                        {reason}
                      </Alert>
                    ) : null}
                    {hasUnmapped ? (
                      <Alert severity={"warning"}>
                        <AlertTitle>{"This arm will be blocked"}</AlertTitle>
                        {
                          "An original observation or required check is explicitly unmapped. The original reproduction requirements remain unchanged."
                        }
                      </Alert>
                    ) : null}
                    {missing ? (
                      <p>{missing} mapping choices still required.</p>
                    ) : (
                      <p>
                        Every original reference has an explicit mapping choice. The server checks
                        the exact source and profile at creation.
                      </p>
                    )}
                    <DataTable
                      rows={required.observations}
                      getRowId={(row) => row.key}
                      columns={[
                        {
                          id: "source",
                          label: "Original observation",
                          render: (original) => {
                            return (
                              <>
                                {observationRefLabel(original.ref)}
                                <span className="evaluation-meta">{original.type}</span>
                              </>
                            );
                          },
                        },
                        {
                          id: "target",
                          label: "Published profile observation",
                          render: (original) => {
                            return (
                              <Autocomplete
                                className="evaluation-check-select"
                                disabled={locked || !profile}
                                options={[
                                  {
                                    value: unmappedObservation,
                                    label: "Unmapped — arm will be blocked",
                                  },
                                  ...observations
                                    .filter((option) => option.type === original.type)
                                    .map((option) => ({
                                      value: option.key,
                                      label: `${option.label} · ${option.type}`,
                                    })),
                                ]}
                                disablePortal
                                fullWidth
                                value={
                                  [
                                    {
                                      value: unmappedObservation,
                                      label: "Unmapped — arm will be blocked",
                                    },
                                    ...observations
                                      .filter((option) => option.type === original.type)
                                      .map((option) => ({
                                        value: option.key,
                                        label: `${option.label} · ${option.type}`,
                                      })),
                                  ].find(
                                    (option) =>
                                      option.value ===
                                      (draft[arm].observations[original.key] === null
                                        ? unmappedObservation
                                        : draft[arm].observations[original.key]),
                                  ) ??
                                  ((draft[arm].observations[original.key] === null
                                    ? unmappedObservation
                                    : draft[arm].observations[original.key]) == null ||
                                  String(
                                    draft[arm].observations[original.key] === null
                                      ? unmappedObservation
                                      : draft[arm].observations[original.key],
                                  ) === ""
                                    ? null
                                    : {
                                        value: (draft[arm].observations[original.key] === null
                                          ? unmappedObservation
                                          : draft[arm].observations[
                                              original.key
                                            ]) as NonNullable<string>,
                                        label: String(
                                          draft[arm].observations[original.key] === null
                                            ? unmappedObservation
                                            : draft[arm].observations[original.key],
                                        ),
                                      })
                                }
                                onChange={(_event, option) => {
                                  if (option !== null)
                                    ((next) => change(arm, "observations", original.key, next))(
                                      option.value as NonNullable<string>,
                                    );
                                }}
                                getOptionLabel={(option) => option.label}
                                isOptionEqualToValue={(option, selected) =>
                                  option.value === selected.value
                                }
                                getOptionDisabled={(option) =>
                                  "disabled" in option && option.disabled === true
                                }
                                renderInput={(params) => (
                                  <TextField
                                    {...params}
                                    label={`${armLabels[arm]} reproduction observation ${original.key} for ${entry.caseId}`}
                                    placeholder={"Choose an observation or Unmapped"}
                                    slotProps={{
                                      ...params.slotProps,
                                      htmlInput: {
                                        ...params.slotProps.htmlInput,
                                        "aria-label": `${armLabels[arm]} reproduction observation ${original.key} for ${entry.caseId}`,
                                      },
                                    }}
                                  />
                                )}
                                disableClearable={Boolean(
                                  draft[arm].observations[original.key] === null
                                    ? unmappedObservation
                                    : draft[arm].observations[original.key],
                                )}
                                getOptionKey={(option) => option.value}
                              />
                            );
                          },
                        },
                      ]}
                      ariaLabel="Evaluation records"
                    />
                    {required.checks.length ? (
                      <DataTable
                        rows={required.checks.map((checkId) => ({
                          checkId,
                        }))}
                        getRowId={(row) => row.checkId}
                        columns={[
                          {
                            id: "checkId",
                            label: "Original check precondition",
                            render: (row) => row.checkId,
                          },
                          {
                            id: "target",
                            label: "Published profile check",
                            render: (original) => {
                              return (
                                <Autocomplete
                                  className="evaluation-check-select"
                                  disabled={locked || !profile}
                                  options={[
                                    {
                                      value: unmappedObservation,
                                      label: "Unmapped — arm will be blocked",
                                    },
                                    ...checks.map((option) => ({
                                      value: option.id,
                                      label: option.label,
                                    })),
                                  ]}
                                  disablePortal
                                  fullWidth
                                  value={
                                    [
                                      {
                                        value: unmappedObservation,
                                        label: "Unmapped — arm will be blocked",
                                      },
                                      ...checks.map((option) => ({
                                        value: option.id,
                                        label: option.label,
                                      })),
                                    ].find(
                                      (option) =>
                                        option.value ===
                                        (draft[arm].checks[original.checkId] === null
                                          ? unmappedObservation
                                          : draft[arm].checks[original.checkId]),
                                    ) ??
                                    ((draft[arm].checks[original.checkId] === null
                                      ? unmappedObservation
                                      : draft[arm].checks[original.checkId]) == null ||
                                    String(
                                      draft[arm].checks[original.checkId] === null
                                        ? unmappedObservation
                                        : draft[arm].checks[original.checkId],
                                    ) === ""
                                      ? null
                                      : {
                                          value: (draft[arm].checks[original.checkId] === null
                                            ? unmappedObservation
                                            : draft[arm].checks[
                                                original.checkId
                                              ]) as NonNullable<string>,
                                          label: String(
                                            draft[arm].checks[original.checkId] === null
                                              ? unmappedObservation
                                              : draft[arm].checks[original.checkId],
                                          ),
                                        })
                                  }
                                  onChange={(_event, option) => {
                                    if (option !== null)
                                      ((next) => change(arm, "checks", original.checkId, next))(
                                        option.value as NonNullable<string>,
                                      );
                                  }}
                                  getOptionLabel={(option) => option.label}
                                  isOptionEqualToValue={(option, selected) =>
                                    option.value === selected.value
                                  }
                                  getOptionDisabled={(option) =>
                                    "disabled" in option && option.disabled === true
                                  }
                                  renderInput={(params) => (
                                    <TextField
                                      {...params}
                                      label={`${armLabels[arm]} reproduction precondition ${original.checkId} for ${entry.caseId}`}
                                      placeholder={"Choose a check or Unmapped"}
                                      slotProps={{
                                        ...params.slotProps,
                                        htmlInput: {
                                          ...params.slotProps.htmlInput,
                                          "aria-label": `${armLabels[arm]} reproduction precondition ${original.checkId} for ${entry.caseId}`,
                                        },
                                      }}
                                    />
                                  )}
                                  disableClearable={Boolean(
                                    draft[arm].checks[original.checkId] === null
                                      ? unmappedObservation
                                      : draft[arm].checks[original.checkId],
                                  )}
                                  getOptionKey={(option) => option.value}
                                />
                              );
                            },
                          },
                        ]}
                        ariaLabel="Evaluation records"
                      />
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : null}
        {previewRequest && completeProfiles ? (
          <ReproductionPreview
            key={JSON.stringify([
              previewRequest,
              read.sourceDefinitionSha256,
              completeProfiles.baseline.configSha256,
              completeProfiles.candidate.configSha256,
            ])}
            api={api}
            request={previewRequest}
            sourceDefinitionSha256={read.sourceDefinitionSha256}
            profiles={completeProfiles}
            disabled={locked}
            onPreview={(preview) =>
              onChange(
                preview
                  ? {
                      ...draft,
                      preview,
                    }
                  : withoutReproductionPreview(draft),
              )
            }
          />
        ) : (
          <p className="evaluation-meta">
            Complete the explicit reproduction mapping choices for both profiles to preview this
            source.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
export function ReproductionMapping({
  api,
  cases,
  sources,
  drafts,
  profiles,
  locked,
  onChange,
}: {
  api: EvaluationReproductionAdapter;
  cases: readonly C.EvaluationSuiteCaseDetailV1[];
  sources: ReproductionSources;
  drafts: ReproductionDrafts;
  profiles: Partial<Record<Arm, C.ValidationProfileVersion>>;
  locked: boolean;
  onChange: (caseId: string, value: ReproductionDraft) => void;
}) {
  return (
    <section aria-label="Issue reproduction configuration">
      <Typography component="h5" variant="subtitle1">
        Reproduction mapping
      </Typography>
      <Typography component="p" variant="body2" color={"text.secondary"}>
        Select historical reproduction cases, then map their observations and required checks
        independently for each arm. Original claim, predicate values and preconditions remain
        frozen. Changing the selected cases or profile clears the affected mapping choices.
      </Typography>
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
        {cases
          .filter((entry) => entry.source.workItemKind === "issue")
          .map((entry) => {
            const read = sources[entry.source.id];
            return read ? (
              <SourceMapping
                key={`${entry.caseId}:${read.sourceDefinitionSha256}`}
                api={api}
                entry={entry}
                read={read}
                value={drafts[entry.caseId]}
                profiles={profiles}
                locked={locked}
                onChange={(draft) => onChange(entry.caseId, draft)}
              />
            ) : null;
          })}
      </Stack>
    </section>
  );
}
