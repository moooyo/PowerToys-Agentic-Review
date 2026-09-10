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
import type { ConfigurationAdapter } from "@/services/configuration";
import type { EvaluationBatchAdapter } from "@/services/evaluation-batches";
import {
  createHttpEvaluationReproductionAdapter,
  type EvaluationReproductionAdapter,
} from "@/services/evaluation-reproduction";
import {
  type Arm,
  armLabels,
  arms,
  assertProfileScope,
  type CheckChoices,
  clearArmChoices,
  createBatchRequest,
  criterionKey,
  loadFrozenCases,
  nullCheckOption,
  permitsProfileOnly,
  profileChecks,
} from "./batch-state";
import {
  MutationNotice,
  useEvaluationPage,
  useEvaluationQuery,
  useOriginalMutation,
} from "./context";
import { EvaluationTable } from "./Display";
import { ReproductionMapping } from "./ReproductionMapping";
import {
  buildReproductionSelections,
  clearReproductionArm,
  loadReproductionSources,
  type ReproductionDrafts,
  requireReproductionPreviews,
} from "./reproduction-state";
import { FrozenSourceLabel } from "./Sources";
import { collectCatalog, errorMessage, newIdentity } from "./state";

interface Selection {
  profileId: string | null;
  profileVersionId: string | null;
  promptVersionId: string | null;
}
const emptySelection = (): Selection => ({
  profileId: null,
  profileVersionId: null,
  promptVersionId: null,
});
const defaultReproductionApi = createHttpEvaluationReproductionAdapter();
function useProfileSelection(
  arm: Arm,
  selection: Selection,
  configuration: ConfigurationAdapter,
  version: C.EvaluationSuiteVersionV1,
  active: boolean,
) {
  const versions = useEvaluationQuery(
    ["batch-profile-versions", arm, selection.profileId],
    () =>
      collectCatalog((page) =>
        configuration.listProfileVersions(version.repositoryId, selection.profileId ?? "", {
          page,
          pageSize: 50,
        }),
      ),
    active && !!selection.profileId,
  );
  const profile = useEvaluationQuery(
    ["batch-profile", selection.profileId, selection.profileVersionId],
    async () => {
      const result = await configuration.getProfileVersion(
        version.repositoryId,
        selection.profileId ?? "",
        selection.profileVersionId ?? "",
      );
      assertProfileScope(result, version);
      return result;
    },
    active && !!selection.profileId && !!selection.profileVersionId,
  );
  return {
    versions,
    profile,
  };
}
export function BatchCreate({
  version,
  api,
  configuration,
  active,
  onCreated,
  onPendingChange,
  reproductionApi = defaultReproductionApi,
}: {
  version: C.EvaluationSuiteVersionV1;
  api: EvaluationBatchAdapter;
  configuration: ConfigurationAdapter;
  active: boolean;
  onCreated: (batch: C.EvaluationBatchSummaryV1) => void;
  onPendingChange: (pending: boolean) => void;
  reproductionApi?: EvaluationReproductionAdapter;
}) {
  const page = useEvaluationPage();
  const [selection, setSelection] = useState<Record<Arm, Selection>>({
    baseline: emptySelection(),
    candidate: emptySelection(),
  });
  const [mode, setMode] = useState<C.EvaluationBatchMode>("prompt_and_profile");
  const [choices, setChoices] = useState<CheckChoices>({});
  const [reproductionDrafts, setReproductionDrafts] = useState<ReproductionDrafts>({});
  const [error, setError] = useState<string | null>(null);
  const profiles = useEvaluationQuery(
    ["batch-profiles", version.workflowKind, version.target],
    async () =>
      (
        await collectCatalog((number) =>
          configuration.listProfiles(page.repositoryId, {
            page: number,
            pageSize: 50,
          }),
        )
      ).filter(
        (profile) =>
          profile.workflowKind === version.workflowKind && profile.target === version.target,
      ),
    active,
  );
  const prompts = useEvaluationQuery(
    ["batch-prompts", version.workflowKind],
    (signal) =>
      collectCatalog((number) =>
        api.listPromptOptions(
          page.repositoryId,
          {
            workflowKind: version.workflowKind,
            page: number,
            pageSize: 50,
          },
          signal,
        ),
      ),
    active,
  );
  const cases = useEvaluationQuery(
    ["batch-expectations", version.suiteId, version.id],
    (signal) => loadFrozenCases(page.api, version, signal),
    active,
  );
  const reproductionSources = useEvaluationQuery(
    ["batch-reproduction-sources", version.suiteId, version.id, version.sourceManifestSha256],
    (signal) => loadReproductionSources(reproductionApi, cases.data ?? [], signal),
    active && version.workflowKind === "issue_validation" && !!cases.data,
  );
  const selectedProfiles = {
    baseline: useProfileSelection("baseline", selection.baseline, configuration, version, active),
    candidate: useProfileSelection(
      "candidate",
      selection.candidate,
      configuration,
      version,
      active,
    ),
  };
  const mutation = useOriginalMutation<C.EvaluationBatchCreateRequest, C.EvaluationBatchSummaryV1>(
    (request) => api.createBatch(page.repositoryId, request, page.principal),
    onCreated,
  );
  useEffect(() => {
    onPendingChange(mutation.busy || mutation.request !== null);
  }, [onPendingChange, mutation.busy, mutation.request]);
  const locked = !active || !page.canConfigure || mutation.busy || mutation.request !== null;
  const change = (arm: Arm, next: Selection) => {
    if (locked) return;
    if (
      next.profileVersionId !== selection[arm].profileVersionId ||
      next.profileId !== selection[arm].profileId
    ) {
      setChoices((previous) => clearArmChoices(previous, arm));
      setReproductionDrafts((previous) => clearReproductionArm(previous, arm));
    }
    setSelection((previous) => ({
      ...previous,
      [arm]: next,
    }));
  };
  const create = () => {
    if (locked || mutation.conflict) return;
    const baseline = selectedProfiles.baseline.profile.data,
      candidate = selectedProfiles.candidate.profile.data;
    const baselinePrompt = prompts.data?.find(
      (prompt) => prompt.id === selection.baseline.promptVersionId,
    );
    const candidatePrompt = prompts.data?.find(
      (prompt) => prompt.id === selection.candidate.promptVersionId,
    );
    if (!cases.data || !baseline || !candidate || !baselinePrompt || !candidatePrompt) {
      setError(
        "Load the frozen cases and select an exact published profile and visible Prompt version for both arms.",
      );
      return;
    }
    try {
      if (
        version.workflowKind === "issue_validation" &&
        (!reproductionSources.data || reproductionSources.isFetching || reproductionSources.error)
      ) {
        setError(
          "Load the exact historical reproduction definitions before creating this Issue validation batch.",
        );
        return;
      }
      const reproductionMappings =
        version.workflowKind === "issue_validation"
          ? buildReproductionSelections({
              cases: cases.data,
              sources: reproductionSources.data ?? {},
              drafts: reproductionDrafts,
              profiles: {
                baseline,
                candidate,
              },
            })
          : undefined;
      if (reproductionMappings)
        requireReproductionPreviews(
          reproductionMappings,
          cases.data,
          reproductionSources.data ?? {},
          reproductionDrafts,
          {
            baseline,
            candidate,
          },
        );
      const request = createBatchRequest({
        changeId: newIdentity(),
        version,
        cases: cases.data,
        profiles: {
          baseline,
          candidate,
        },
        prompts: {
          baseline: baselinePrompt,
          candidate: candidatePrompt,
        },
        mode,
        choices,
        ...(reproductionMappings?.length
          ? {
              reproductionMappings,
            }
          : {}),
      });
      setError(null);
      mutation.submit(request);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };
  const queryError =
    profiles.error ??
    prompts.error ??
    cases.error ??
    reproductionSources.error ??
    selectedProfiles.baseline.versions.error ??
    selectedProfiles.baseline.profile.error ??
    selectedProfiles.candidate.versions.error ??
    selectedProfiles.candidate.profile.error;
  const rows = (cases.data ?? []).flatMap((entry) =>
    entry.expectation.criteria.map((criterion) => ({
      key: criterionKey(entry.caseId, criterion.criterionId),
      entry,
      criterion,
    })),
  );
  return (
    <Card variant="elevation" elevation={0} className="evaluation-section-card">
      <CardHeader
        title={`Create batch from version ${version.version}`}
        slotProps={{
          title: {
            variant: "subtitle1",
            component: "h3",
          },
        }}
      />
      <CardContent>
        <Stack
          direction="row"
          spacing={1.5}
          sx={{
            alignItems: "center",
            flexWrap: "wrap",
            gap: 1,
          }}
        >
          <Chip label={version.workflowKind} />
          <Chip label={version.target} />
          <Typography component="span" variant="body2" color={"text.secondary"}>
            {version.id} · {version.caseCount} cases · one trial per arm
          </Typography>
        </Stack>
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
                value: "prompt_and_profile",
                label: "Prompt and profile",
              },
              ...(permitsProfileOnly(version.workflowKind)
                ? [
                    {
                      value: "profile_only",
                      label: "Profile only",
                    },
                  ]
                : []),
            ]}
            disablePortal
            fullWidth
            disabled={locked}
            value={
              [
                {
                  value: "prompt_and_profile",
                  label: "Prompt and profile",
                },
                ...(permitsProfileOnly(version.workflowKind)
                  ? [
                      {
                        value: "profile_only",
                        label: "Profile only",
                      },
                    ]
                  : []),
              ].find((option) => option.value === mode) ??
              (mode == null || String(mode) === ""
                ? null
                : {
                    value: mode as NonNullable<typeof mode>,
                    label: String(mode),
                  })
            }
            onChange={(_event, option) => {
              if (option !== null) setMode(option.value as NonNullable<typeof mode>);
            }}
            getOptionLabel={(option) => option.label}
            isOptionEqualToValue={(option, selected) => option.value === selected.value}
            getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
            renderInput={(params) => (
              <TextField
                {...params}
                label={"Execution mode"}
                slotProps={{
                  ...params.slotProps,
                  htmlInput: {
                    ...params.slotProps.htmlInput,
                    "aria-label": "Batch execution mode",
                  },
                }}
              />
            )}
            disableClearable={Boolean(mode)}
            getOptionKey={(option) => option.value}
          />
          <p className="evaluation-meta">
            {mode === "profile_only"
              ? "Both Prompt identities are still frozen for provenance; the model does not run in this mode."
              : "The Worker runs its configured model CLI. Completed results show the CLI, version and requested model."}
          </p>
          <div className="evaluation-arm-grid">
            {arms.map((arm) => (
              <Card key={arm} variant="elevation" elevation={0} className="evaluation-tonal-card">
                <CardHeader
                  title={armLabels[arm]}
                  slotProps={{
                    title: {
                      variant: "subtitle1",
                      component: "h3",
                    },
                  }}
                />
                <CardContent>
                  <Autocomplete
                    loading={profiles.isFetching}
                    options={(profiles.data ?? []).map((profile) => ({
                      value: profile.profileId,
                      label: profile.name,
                    }))}
                    disablePortal
                    fullWidth
                    disabled={locked}
                    value={
                      (profiles.data ?? [])
                        .map((profile) => ({
                          value: profile.profileId,
                          label: profile.name,
                        }))
                        .find((option) => option.value === selection[arm].profileId) ??
                      (selection[arm].profileId == null || String(selection[arm].profileId) === ""
                        ? null
                        : {
                            value: selection[arm].profileId as NonNullable<
                              NonNullable<NonNullable<typeof selection>[typeof arm]>["profileId"]
                            >,
                            label: String(selection[arm].profileId),
                          })
                    }
                    onChange={(_event, option) => {
                      if (option !== null)
                        ((profileId) =>
                          change(arm, {
                            ...selection[arm],
                            profileId,
                            profileVersionId: null,
                          }))(
                          option.value as NonNullable<
                            NonNullable<NonNullable<typeof selection>[typeof arm]>["profileId"]
                          >,
                        );
                    }}
                    getOptionLabel={(option) => option.label}
                    isOptionEqualToValue={(option, selected) => option.value === selected.value}
                    getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label={`${armLabels[arm]} profile`}
                        placeholder={"Select repository profile"}
                        required
                        slotProps={{
                          ...params.slotProps,
                          htmlInput: {
                            ...params.slotProps.htmlInput,
                            "aria-label": `${armLabels[arm]} profile`,
                          },
                        }}
                      />
                    )}
                    disableClearable={Boolean(selection[arm].profileId)}
                    getOptionKey={(option) => option.value}
                  />
                  <Autocomplete
                    disabled={locked || !selection[arm].profileId}
                    loading={selectedProfiles[arm].versions.isFetching}
                    options={(selectedProfiles[arm].versions.data ?? [])
                      .filter(
                        (profile) =>
                          profile.workflowKind === version.workflowKind &&
                          profile.target === version.target,
                      )
                      .map((profile) => ({
                        value: profile.id,
                        label: `Version ${profile.version} · ${profile.id}`,
                      }))}
                    disablePortal
                    fullWidth
                    value={
                      (selectedProfiles[arm].versions.data ?? [])
                        .filter(
                          (profile) =>
                            profile.workflowKind === version.workflowKind &&
                            profile.target === version.target,
                        )
                        .map((profile) => ({
                          value: profile.id,
                          label: `Version ${profile.version} · ${profile.id}`,
                        }))
                        .find((option) => option.value === selection[arm].profileVersionId) ??
                      (selection[arm].profileVersionId == null ||
                      String(selection[arm].profileVersionId) === ""
                        ? null
                        : {
                            value: selection[arm].profileVersionId as NonNullable<
                              NonNullable<
                                NonNullable<typeof selection>[typeof arm]
                              >["profileVersionId"]
                            >,
                            label: String(selection[arm].profileVersionId),
                          })
                    }
                    onChange={(_event, option) => {
                      if (option !== null)
                        ((profileVersionId) =>
                          change(arm, {
                            ...selection[arm],
                            profileVersionId,
                          }))(
                          option.value as NonNullable<
                            NonNullable<
                              NonNullable<typeof selection>[typeof arm]
                            >["profileVersionId"]
                          >,
                        );
                    }}
                    getOptionLabel={(option) => option.label}
                    isOptionEqualToValue={(option, selected) => option.value === selected.value}
                    getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label={`${armLabels[arm]} profile version`}
                        placeholder={"Select immutable version"}
                        required
                        slotProps={{
                          ...params.slotProps,
                          htmlInput: {
                            ...params.slotProps.htmlInput,
                            "aria-label": `${armLabels[arm]} profile version`,
                          },
                        }}
                      />
                    )}
                    disableClearable={Boolean(selection[arm].profileVersionId)}
                    getOptionKey={(option) => option.value}
                  />
                  <Autocomplete
                    loading={prompts.isFetching}
                    options={(prompts.data ?? []).map((prompt) => ({
                      value: prompt.id,
                      label: `${prompt.templateName} · version ${prompt.version} · ${prompt.visibility}`,
                    }))}
                    disablePortal
                    fullWidth
                    disabled={locked}
                    value={
                      (prompts.data ?? [])
                        .map((prompt) => ({
                          value: prompt.id,
                          label: `${prompt.templateName} · version ${prompt.version} · ${prompt.visibility}`,
                        }))
                        .find((option) => option.value === selection[arm].promptVersionId) ??
                      (selection[arm].promptVersionId == null ||
                      String(selection[arm].promptVersionId) === ""
                        ? null
                        : {
                            value: selection[arm].promptVersionId as NonNullable<
                              NonNullable<
                                NonNullable<typeof selection>[typeof arm]
                              >["promptVersionId"]
                            >,
                            label: String(selection[arm].promptVersionId),
                          })
                    }
                    onChange={(_event, option) => {
                      if (option !== null)
                        ((promptVersionId) =>
                          change(arm, {
                            ...selection[arm],
                            promptVersionId,
                          }))(
                          option.value as NonNullable<
                            NonNullable<
                              NonNullable<typeof selection>[typeof arm]
                            >["promptVersionId"]
                          >,
                        );
                    }}
                    getOptionLabel={(option) => option.label}
                    isOptionEqualToValue={(option, selected) => option.value === selected.value}
                    getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label={`${armLabels[arm]} Prompt version`}
                        placeholder={"Select repository-visible Prompt"}
                        required
                        slotProps={{
                          ...params.slotProps,
                          htmlInput: {
                            ...params.slotProps.htmlInput,
                            "aria-label": `${armLabels[arm]} Prompt version`,
                          },
                        }}
                      />
                    )}
                    disableClearable={Boolean(selection[arm].promptVersionId)}
                    getOptionKey={(option) => option.value}
                  />
                  {selectedProfiles[arm].profile.data ? (
                    <p className="evaluation-meta">
                      {profileChecks(selectedProfiles[arm].profile.data).length} frozen build, test
                      and UI checks · {selectedProfiles[arm].profile.data.configSha256}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>
        </Stack>
        {version.workflowKind === "issue_validation" ? (
          <>
            {reproductionSources.isFetching ? (
              <p>Loading original reproduction definitions…</p>
            ) : null}
            {reproductionSources.data && cases.data ? (
              <ReproductionMapping
                api={reproductionApi}
                cases={cases.data}
                sources={reproductionSources.data}
                drafts={reproductionDrafts}
                profiles={{
                  baseline: selectedProfiles.baseline.profile.data,
                  candidate: selectedProfiles.candidate.profile.data,
                }}
                locked={locked || reproductionSources.isFetching}
                onChange={(caseId, draft) =>
                  setReproductionDrafts((previous) => ({
                    ...previous,
                    [caseId]: draft,
                  }))
                }
              />
            ) : null}
          </>
        ) : null}
        <Typography component="h5" variant="subtitle1">
          Criterion mapping
        </Typography>
        <Typography component="p" variant="body2" color={"text.secondary"}>
          Choose a check or explicit No check for every frozen criterion in each arm. No check is a
          missing mapping, never a passed outcome. Changing a profile version clears that arm's
          choices.
        </Typography>
        {queryError ? (
          <Alert severity={"error"}>
            <AlertTitle>{"Configuration unavailable"}</AlertTitle>
            {errorMessage(queryError)}
          </Alert>
        ) : null}
        <EvaluationTable
          loading={active && cases.isPending}
          rows={rows}
          getRowId={(row) => row.key}
          columns={[
            {
              id: "criterion",
              label: "Frozen criterion",
              width: "40%",
              render: (row) => {
                return (
                  <div>
                    <strong>{row.entry.expectation.title}</strong>
                    <FrozenSourceLabel source={row.entry.source} />
                    <p>{row.criterion.description}</p>
                    <span className="evaluation-meta">
                      {row.criterion.criterionId} · Expected {row.criterion.expectedOutcome} ·{" "}
                      {row.criterion.applicability.state === "applicable"
                        ? "Applicable"
                        : `Not applicable: ${row.criterion.applicability.reason}`}{" "}
                      · {row.entry.expectation.findings.annotation} finding labels
                    </span>
                  </div>
                );
              },
            },
            ...arms.map((arm) => ({
              id: arm,
              label: armLabels[arm],
              width: "30%",
              render: (row: (typeof rows)[number]) => {
                return (
                  <Autocomplete
                    className="evaluation-check-select"
                    disabled={locked || !selectedProfiles[arm].profile.data}
                    options={[
                      {
                        value: nullCheckOption,
                        label: "No check (explicit null)",
                      },
                      ...(selectedProfiles[arm].profile.data
                        ? profileChecks(selectedProfiles[arm].profile.data)
                        : []),
                    ]}
                    disablePortal
                    fullWidth
                    value={
                      [
                        {
                          value: nullCheckOption,
                          label: "No check (explicit null)",
                        },
                        ...(selectedProfiles[arm].profile.data
                          ? profileChecks(selectedProfiles[arm].profile.data)
                          : []),
                      ].find(
                        (option) =>
                          option.value ===
                          (choices[row.key]?.[arm] === null
                            ? nullCheckOption
                            : choices[row.key]?.[arm]),
                      ) ??
                      ((choices[row.key]?.[arm] === null
                        ? nullCheckOption
                        : choices[row.key]?.[arm]) == null ||
                      String(
                        choices[row.key]?.[arm] === null
                          ? nullCheckOption
                          : choices[row.key]?.[arm],
                      ) === ""
                        ? null
                        : {
                            value: (choices[row.key]?.[arm] === null
                              ? nullCheckOption
                              : choices[row.key]?.[arm]) as NonNullable<string>,
                            label: String(
                              choices[row.key]?.[arm] === null
                                ? nullCheckOption
                                : choices[row.key]?.[arm],
                            ),
                          })
                    }
                    onChange={(_event, option) => {
                      if (option !== null)
                        ((value) => {
                          if (!locked)
                            setChoices((previous) => ({
                              ...previous,
                              [row.key]: {
                                ...previous[row.key],
                                [arm]: value === nullCheckOption ? null : value,
                              },
                            }));
                        })(option.value as NonNullable<string>);
                    }}
                    getOptionLabel={(option) => option.label}
                    isOptionEqualToValue={(option, selected) => option.value === selected.value}
                    getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label={`${armLabels[arm]} check for case ${row.entry.caseId}, criterion ${row.criterion.criterionId}`}
                        placeholder={"Choose a check or explicit No check"}
                        slotProps={{
                          ...params.slotProps,
                          htmlInput: {
                            ...params.slotProps.htmlInput,
                            "aria-label": `${armLabels[arm]} check for case ${row.entry.caseId}, criterion ${row.criterion.criterionId}`,
                          },
                        }}
                      />
                    )}
                    disableClearable={Boolean(
                      choices[row.key]?.[arm] === null ? nullCheckOption : choices[row.key]?.[arm],
                    )}
                    getOptionKey={(option) => option.value}
                  />
                );
              },
            })),
          ]}
          ariaLabel="Evaluation records"
          emptyTitle={
            cases.data
              ? "This published version has no criteria. Its finding labels remain unchanged."
              : "Load the frozen criteria before creating a batch."
          }
          pageSize={12}
        />
        {error ? (
          <Alert severity={"error"}>
            <AlertTitle>{"Review the batch configuration"}</AlertTitle>
            {error}
          </Alert>
        ) : null}
        <MutationNotice
          mutation={mutation}
          conflictTitle="Batch creation was rejected"
          conflictDescription="The original form is preserved. Review the current published configuration before creating a new request."
        />
        {mutation.conflict ? (
          <Button disabled={locked} onClick={mutation.reset} variant="outlined">
            Review configuration again
          </Button>
        ) : null}
        <Button
          disabled={locked || mutation.conflict}
          loading={mutation.busy}
          onClick={create}
          variant="contained"
        >
          Create evaluation batch
        </Button>
      </CardContent>
    </Card>
  );
}
