import type * as C from "@agentic-review/contracts";
import { Alert, Card, Form, Select, Space, Table, Tag, Typography } from "antd";
import {
  getObservationOptions,
  getPreconditionChecks,
  observationRefKey,
  reproductionProfileUnavailableReason,
} from "@/components/CreateReviewRun/reproduction";
import { observationRefLabel, observationValueLabel } from "@/components/IssueReproduction/state";
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
      <Typography.Text strong>{title}</Typography.Text>
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
              <Typography.Text code>{observationValueLabel(predicate.equals)}</Typography.Text>
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
    <Card size="small" title={value.id}>
      <Typography.Paragraph>{value.context}</Typography.Paragraph>
      <span className="evaluation-meta">
        Original profile {value.profileVersionId} · {value.target}
      </span>
      <Typography.Text strong>Required preconditions</Typography.Text>
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
                  <Typography.Text code>
                    {observationValueLabel(control.predicate.equals)}
                  </Typography.Text>
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
      <Signature title="Issue absent when every observation matches" signature={value.absentWhen} />
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
      <Card size="small" title={entry.expectation.title}>
        <FrozenSourceLabel source={entry.source} />
        <Typography.Paragraph type="secondary">
          This source has no frozen reproduction definition. No observation mapping will be inferred
          from its scoring labels.
        </Typography.Paragraph>
      </Card>
    );
  const draft = reproductionDraft(value, read.sourceDefinitionSha256);
  const selected = definition.binding.cases.filter((original) =>
    draft.selectedCaseIds.includes(original.id),
  );
  const required = reproductionRequirements(selected);
  const completeProfiles =
    profiles.baseline && profiles.candidate
      ? { baseline: profiles.baseline, candidate: profiles.candidate }
      : null;
  let previewRequest: C.EvaluationReproductionPreviewRequest | null = null;
  if (completeProfiles) {
    try {
      const selection = buildReproductionSelections({
        cases: [entry],
        sources: { [entry.source.id]: read },
        drafts: { [entry.caseId]: draft },
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
        [kind]: { ...draft[arm][kind], [key]: next === unmappedObservation ? null : next },
      },
    });
  };
  return (
    <Card size="small" title={entry.expectation.title}>
      <FrozenSourceLabel source={entry.source} />
      <Typography.Paragraph strong>{definition.binding.claim}</Typography.Paragraph>
      <span className="evaluation-meta">
        Original run {definition.reviewRunId} · frozen source {definition.sourceId}
      </span>
      <Form layout="vertical">
        <Form.Item label="Original reproduction cases" required>
          <Select
            mode="multiple"
            aria-label={`Original reproduction cases for ${entry.caseId}`}
            placeholder="Explicitly select original cases to reproduce"
            value={draft.selectedCaseIds}
            disabled={locked}
            options={definition.binding.cases.map((original) => ({
              value: original.id,
              label: `${original.id} · ${original.context}`,
            }))}
            onChange={(selectedCaseIds: string[]) => {
              if (!locked)
                onChange({
                  ...withoutReproductionPreview(draft),
                  selectedCaseIds,
                  baseline: emptyReproductionArm(),
                  candidate: emptyReproductionArm(),
                });
            }}
          />
        </Form.Item>
      </Form>
      <Space orientation="vertical" style={{ width: "100%" }}>
        {definition.binding.cases.map((original) => (
          <div key={original.id}>
            <Tag>
              {draft.selectedCaseIds.includes(original.id)
                ? "Selected for both arms"
                : "Not selected"}
            </Tag>
            <OriginalReproductionCase value={original} />
          </div>
        ))}
      </Space>
      {selected.length ? (
        <div className="evaluation-arm-grid" style={{ marginTop: 16 }}>
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
              <Card size="small" title={`${armLabels[arm]} reproduction mapping`} key={arm}>
                {reason ? (
                  <Alert
                    type="warning"
                    showIcon
                    title="Observations unavailable"
                    description={reason}
                  />
                ) : null}
                {hasUnmapped ? (
                  <Alert
                    type="warning"
                    showIcon
                    title="This arm will be blocked"
                    description="An original observation or required check is explicitly unmapped. The original reproduction requirements remain unchanged."
                  />
                ) : null}
                {missing ? (
                  <p>{missing} mapping choices still required.</p>
                ) : (
                  <p>
                    Every original reference has an explicit mapping choice. The server checks the
                    exact source and profile at creation.
                  </p>
                )}
                <Table
                  rowKey="key"
                  size="small"
                  pagination={false}
                  dataSource={required.observations}
                  scroll={{ x: 440 }}
                  columns={[
                    {
                      title: "Original observation",
                      key: "source",
                      render: (_, original) => (
                        <>
                          {observationRefLabel(original.ref)}
                          <span className="evaluation-meta">{original.type}</span>
                        </>
                      ),
                    },
                    {
                      title: "Published profile observation",
                      key: "target",
                      render: (_, original) => (
                        <Select
                          className="evaluation-check-select"
                          aria-label={`${armLabels[arm]} reproduction observation ${original.key} for ${entry.caseId}`}
                          value={
                            draft[arm].observations[original.key] === null
                              ? unmappedObservation
                              : draft[arm].observations[original.key]
                          }
                          placeholder="Choose an observation or Unmapped"
                          disabled={locked || !profile}
                          showSearch
                          optionFilterProp="label"
                          options={[
                            { value: unmappedObservation, label: "Unmapped — arm will be blocked" },
                            ...observations
                              .filter((option) => option.type === original.type)
                              .map((option) => ({
                                value: option.key,
                                label: `${option.label} · ${option.type}`,
                              })),
                          ]}
                          onChange={(next) => change(arm, "observations", original.key, next)}
                        />
                      ),
                    },
                  ]}
                />
                {required.checks.length ? (
                  <Table
                    rowKey="checkId"
                    size="small"
                    pagination={false}
                    dataSource={required.checks.map((checkId) => ({ checkId }))}
                    scroll={{ x: 440 }}
                    columns={[
                      { title: "Original check precondition", dataIndex: "checkId" },
                      {
                        title: "Published profile check",
                        key: "target",
                        render: (_, original) => (
                          <Select
                            className="evaluation-check-select"
                            aria-label={`${armLabels[arm]} reproduction precondition ${original.checkId} for ${entry.caseId}`}
                            value={
                              draft[arm].checks[original.checkId] === null
                                ? unmappedObservation
                                : draft[arm].checks[original.checkId]
                            }
                            placeholder="Choose a check or Unmapped"
                            disabled={locked || !profile}
                            showSearch
                            optionFilterProp="label"
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
                            onChange={(next) => change(arm, "checks", original.checkId, next)}
                          />
                        ),
                      },
                    ]}
                  />
                ) : null}
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
            onChange(preview ? { ...draft, preview } : withoutReproductionPreview(draft))
          }
        />
      ) : (
        <p className="evaluation-meta">
          Complete the explicit reproduction mapping choices for both profiles to preview this
          source.
        </p>
      )}
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
      <Typography.Title level={5}>Reproduction mapping</Typography.Title>
      <Typography.Paragraph type="secondary">
        Select historical reproduction cases, then map their observations and required checks
        independently for each arm. Original claim, predicate values and preconditions remain
        frozen. Changing the selected cases or profile clears the affected mapping choices.
      </Typography.Paragraph>
      <Space orientation="vertical" style={{ width: "100%" }}>
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
      </Space>
    </section>
  );
}
