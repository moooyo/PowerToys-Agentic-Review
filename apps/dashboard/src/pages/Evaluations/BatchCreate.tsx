import type * as C from "@agentic-review/contracts";
import { Alert, Button, Card, Form, Select, Space, Table, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import type { ConfigurationAdapter } from "@/services/configuration";
import type { EvaluationBatchAdapter } from "@/services/evaluation-batches";
import {
  createHttpEvaluationReproductionAdapter,
  type EvaluationReproductionAdapter,
} from "@/services/evaluation-reproduction";
import {
  createHttpModelRuntimeRegistrationAdapter,
  type ModelRuntimeRegistrationAdapter,
} from "@/services/model-runtime-registrations";
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
  modelRuntimeRegistrationId: string | null;
}
const emptySelection = (): Selection => ({
  profileId: null,
  profileVersionId: null,
  promptVersionId: null,
  modelRuntimeRegistrationId: null,
});
const defaultRuntimeApi = createHttpModelRuntimeRegistrationAdapter();
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
  return { versions, profile };
}

export function BatchCreate({
  version,
  api,
  configuration,
  active,
  onCreated,
  onPendingChange,
  runtimeApi = defaultRuntimeApi,
  reproductionApi = defaultReproductionApi,
}: {
  version: C.EvaluationSuiteVersionV1;
  api: EvaluationBatchAdapter;
  configuration: ConfigurationAdapter;
  active: boolean;
  onCreated: (batch: C.EvaluationBatchSummaryV1) => void;
  onPendingChange: (pending: boolean) => void;
  runtimeApi?: Pick<ModelRuntimeRegistrationAdapter, "options">;
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
          configuration.listProfiles(page.repositoryId, { page: number, pageSize: 50 }),
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
          { workflowKind: version.workflowKind, page: number, pageSize: 50 },
          signal,
        ),
      ),
    active,
  );
  const runtimes = useEvaluationQuery(
    ["batch-model-runtime-options", page.repositoryId],
    (signal) =>
      collectCatalog((number) =>
        runtimeApi.options(page.repositoryId, { page: number, pageSize: 50 }, signal),
      ),
    active && page.canConfigure && mode === "prompt_and_profile",
  );
  const availableRuntimes = page.canConfigure ? runtimes.data : undefined;
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
    setSelection((previous) => ({ ...previous, [arm]: next }));
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
    const baselineRuntime = availableRuntimes?.find(
      (entry) => entry.id === selection.baseline.modelRuntimeRegistrationId,
    );
    const candidateRuntime = availableRuntimes?.find(
      (entry) => entry.id === selection.candidate.modelRuntimeRegistrationId,
    );
    if (
      mode === "prompt_and_profile" &&
      (runtimes.isFetching || runtimes.error || !baselineRuntime || !candidateRuntime)
    ) {
      setError(
        "Select an available registered model configuration for both arms. Refresh the model options if a selection is unavailable.",
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
              profiles: { baseline, candidate },
            })
          : undefined;
      if (reproductionMappings)
        requireReproductionPreviews(
          reproductionMappings,
          cases.data,
          reproductionSources.data ?? {},
          reproductionDrafts,
          { baseline, candidate },
        );
      const request = createBatchRequest({
        changeId: newIdentity(),
        version,
        cases: cases.data,
        profiles: { baseline, candidate },
        prompts: { baseline: baselinePrompt, candidate: candidatePrompt },
        ...(mode === "prompt_and_profile" && baselineRuntime && candidateRuntime
          ? { modelRuntimes: { baseline: baselineRuntime, candidate: candidateRuntime } }
          : {}),
        mode,
        choices,
        ...(reproductionMappings?.length ? { reproductionMappings } : {}),
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
    (mode === "prompt_and_profile" ? runtimes.error : null) ??
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
    <Card size="small" title={`Create batch from version ${version.version}`}>
      <Space wrap>
        <Tag>{version.workflowKind}</Tag>
        <Tag>{version.target}</Tag>
        <Typography.Text type="secondary">
          {version.id} · {version.caseCount} cases · one trial per arm
        </Typography.Text>
      </Space>
      <Form layout="vertical" disabled={locked}>
        <Form.Item label="Execution mode">
          <Select
            aria-label="Batch execution mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: "prompt_and_profile", label: "Prompt and profile" },
              ...(permitsProfileOnly(version.workflowKind)
                ? [{ value: "profile_only", label: "Profile only" }]
                : []),
            ]}
          />
        </Form.Item>
        <p className="evaluation-meta">
          {mode === "profile_only"
            ? "Both Prompt identities are still frozen for provenance; the model does not run in this mode."
            : "Model execution requires an admitted evaluation boundary. Creating a batch does not guarantee Worker admission."}
        </p>
        {mode === "prompt_and_profile" ? (
          <Space direction="vertical" style={{ width: "100%", marginBottom: 16 }}>
            <Typography.Text type="secondary">
              Registered models define the expected configuration. They do not confirm Worker
              readiness or actual model execution.
            </Typography.Text>
            <Button
              disabled={!active || !page.canConfigure}
              loading={runtimes.isFetching}
              onClick={() => runtimes.refetch()}
            >
              Refresh model options
            </Button>
          </Space>
        ) : null}
        <div className="evaluation-arm-grid">
          {arms.map((arm) => (
            <Card size="small" title={armLabels[arm]} key={arm}>
              <Form.Item label={`${armLabels[arm]} profile`} required>
                <Select
                  aria-label={`${armLabels[arm]} profile`}
                  value={selection[arm].profileId}
                  placeholder="Select repository profile"
                  showSearch
                  optionFilterProp="label"
                  loading={profiles.isFetching}
                  options={(profiles.data ?? []).map((profile) => ({
                    value: profile.profileId,
                    label: profile.name,
                  }))}
                  onChange={(profileId) =>
                    change(arm, { ...selection[arm], profileId, profileVersionId: null })
                  }
                />
              </Form.Item>
              <Form.Item label={`${armLabels[arm]} profile version`} required>
                <Select
                  aria-label={`${armLabels[arm]} profile version`}
                  value={selection[arm].profileVersionId}
                  disabled={locked || !selection[arm].profileId}
                  placeholder="Select immutable version"
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
                  onChange={(profileVersionId) =>
                    change(arm, { ...selection[arm], profileVersionId })
                  }
                />
              </Form.Item>
              <Form.Item label={`${armLabels[arm]} Prompt version`} required>
                <Select
                  aria-label={`${armLabels[arm]} Prompt version`}
                  value={selection[arm].promptVersionId}
                  placeholder="Select repository-visible Prompt"
                  showSearch
                  optionFilterProp="label"
                  loading={prompts.isFetching}
                  options={(prompts.data ?? []).map((prompt) => ({
                    value: prompt.id,
                    label: `${prompt.templateName} · version ${prompt.version} · ${prompt.visibility}`,
                  }))}
                  onChange={(promptVersionId) =>
                    change(arm, { ...selection[arm], promptVersionId })
                  }
                />
              </Form.Item>
              {mode === "prompt_and_profile" && page.canConfigure ? (
                <Form.Item label={`${armLabels[arm]} model runtime`} required>
                  <Select
                    aria-label={`${armLabels[arm]} model runtime`}
                    value={selection[arm].modelRuntimeRegistrationId}
                    placeholder="Select registered expected configuration"
                    showSearch
                    optionFilterProp="label"
                    loading={runtimes.isFetching}
                    options={[
                      ...(availableRuntimes ?? []).map((runtime) => ({
                        value: runtime.id,
                        label: `${runtime.name} · ${runtime.requestedModel}`,
                      })),
                      ...(selection[arm].modelRuntimeRegistrationId &&
                      !availableRuntimes?.some(
                        (runtime) => runtime.id === selection[arm].modelRuntimeRegistrationId,
                      )
                        ? [
                            {
                              value: selection[arm].modelRuntimeRegistrationId,
                              label: `Unavailable registration · ${selection[arm].modelRuntimeRegistrationId}`,
                              disabled: true,
                            },
                          ]
                        : []),
                    ]}
                    onChange={(modelRuntimeRegistrationId) =>
                      change(arm, { ...selection[arm], modelRuntimeRegistrationId })
                    }
                  />
                </Form.Item>
              ) : null}
              {selectedProfiles[arm].profile.data ? (
                <p className="evaluation-meta">
                  {profileChecks(selectedProfiles[arm].profile.data).length} frozen build, test and
                  UI checks · {selectedProfiles[arm].profile.data.configSha256}
                </p>
              ) : null}
            </Card>
          ))}
        </div>
      </Form>
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
                setReproductionDrafts((previous) => ({ ...previous, [caseId]: draft }))
              }
            />
          ) : null}
        </>
      ) : null}
      <Typography.Title level={5}>Criterion mapping</Typography.Title>
      <Typography.Paragraph type="secondary">
        Choose a check or explicit No check for every frozen criterion in each arm. No check is a
        missing mapping, never a passed outcome. Changing a profile version clears that arm's
        choices.
      </Typography.Paragraph>
      {queryError ? (
        <Alert
          type="error"
          title="Configuration unavailable"
          description={errorMessage(queryError)}
        />
      ) : null}
      <Table
        rowKey="key"
        size="small"
        dataSource={rows}
        loading={active && cases.isPending}
        pagination={{ pageSize: 12, showSizeChanger: false, hideOnSinglePage: true }}
        scroll={{ x: 760 }}
        locale={{
          emptyText: cases.data
            ? "This published version has no criteria. Its finding labels remain unchanged."
            : "Load the frozen criteria before creating a batch.",
        }}
        columns={[
          {
            title: "Frozen criterion",
            key: "criterion",
            width: "40%",
            render: (_, row) => (
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
            ),
          },
          ...arms.map((arm) => ({
            title: armLabels[arm],
            key: arm,
            width: "30%",
            render: (_: unknown, row: (typeof rows)[number]) => (
              <Select
                className="evaluation-check-select"
                aria-label={`${armLabels[arm]} check for case ${row.entry.caseId}, criterion ${row.criterion.criterionId}`}
                disabled={locked || !selectedProfiles[arm].profile.data}
                value={choices[row.key]?.[arm] === null ? nullCheckOption : choices[row.key]?.[arm]}
                placeholder="Choose a check or explicit No check"
                showSearch
                optionFilterProp="label"
                options={[
                  { value: nullCheckOption, label: "No check (explicit null)" },
                  ...(selectedProfiles[arm].profile.data
                    ? profileChecks(selectedProfiles[arm].profile.data)
                    : []),
                ]}
                onChange={(value) => {
                  if (!locked)
                    setChoices((previous) => ({
                      ...previous,
                      [row.key]: {
                        ...previous[row.key],
                        [arm]: value === nullCheckOption ? null : value,
                      },
                    }));
                }}
              />
            ),
          })),
        ]}
      />
      {error ? (
        <Alert type="error" title="Review the batch configuration" description={error} />
      ) : null}
      <MutationNotice
        mutation={mutation}
        conflictTitle="Batch creation was rejected"
        conflictDescription="The original form is preserved. Review the current published configuration before creating a new request."
      />
      {mutation.conflict ? (
        <Button disabled={locked} onClick={mutation.reset}>
          Review configuration again
        </Button>
      ) : null}
      <Button
        type="primary"
        disabled={locked || mutation.conflict}
        loading={mutation.busy}
        onClick={create}
      >
        Create evaluation batch
      </Button>
    </Card>
  );
}
