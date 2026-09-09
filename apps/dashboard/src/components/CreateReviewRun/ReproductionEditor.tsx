import type {
  IssueReproductionCaseRequest,
  IssueReproductionRequestV1,
  ObservationEquals,
  ObservationSignature,
  ObservationValue,
  ReproductionPrecondition,
  ValidationProfileVersion,
} from "@agentic-review/contracts";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { useRef } from "react";
import { targetLabels } from "@/pages/ValidationProfiles/forms";
import type { RunProfileOption } from "./helpers";
import {
  getObservationOptions,
  getPreconditionChecks,
  getReproductionProfileOptions,
  observationRefKey,
  reproductionProfileUnavailableReason,
} from "./reproduction";

interface ReproductionEditorProps {
  readonly profiles: readonly RunProfileOption[];
  readonly selectedProfileIds: readonly string[];
  readonly value: IssueReproductionRequestV1 | undefined;
  readonly onChange: (value: IssueReproductionRequestV1 | undefined) => void;
  readonly defaultClaim: string;
  readonly disabled: boolean;
  readonly sample: boolean;
}

const vertical = { width: "100%" };
const row = { display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "start" };
const observationColumn = { flex: "2 1 240px", minWidth: 0 };
const valueColumn = { flex: "1 1 160px", minWidth: 0 };

function useRowKeys<T extends object>() {
  const keys = useRef(new WeakMap<T, string>());
  const keyFor = (value: T): string => {
    const key = keys.current.get(value) ?? crypto.randomUUID();
    keys.current.set(value, key);
    return key;
  };
  return { keyFor, replaceKey: (previous: T, next: T) => keys.current.set(next, keyFor(previous)) };
}

function defaultValue(type: ObservationValue["type"]): ObservationValue {
  if (type === "boolean") return { type, value: true };
  if (type === "number") return { type, value: 0 };
  return { type, value: "" };
}

function firstPredicate(profile: ValidationProfileVersion): ObservationEquals | undefined {
  const observation = getObservationOptions(profile)[0];
  return observation === undefined
    ? undefined
    : { observation: observation.ref, equals: defaultValue(observation.type) };
}

function newCase(profile: ValidationProfileVersion): IssueReproductionCaseRequest {
  const predicate = firstPredicate(profile);
  return {
    id: `case-${crypto.randomUUID()}`,
    profileId: profile.profileId,
    expectedProfileVersionId: profile.id,
    context: "",
    preconditions: [],
    presentWhen: { allOf: predicate === undefined ? [] : [predicate] },
    absentWhen: null,
  };
}

function ExactValue({
  value,
  onChange,
  label,
  disabled,
}: {
  readonly value: ObservationValue;
  readonly onChange: (value: ObservationValue) => void;
  readonly label: string;
  readonly disabled: boolean;
}) {
  if (value.type === "boolean")
    return (
      <Select
        aria-label={label}
        value={value.value ? "true" : "false"}
        disabled={disabled}
        style={vertical}
        options={[
          { value: "true", label: "True" },
          { value: "false", label: "False" },
        ]}
        onChange={(next) => onChange({ type: "boolean", value: next === "true" })}
      />
    );
  if (value.type === "number")
    return (
      <InputNumber
        aria-label={label}
        disabled={disabled}
        style={vertical}
        value={Number.isFinite(value.value) ? value.value : null}
        onChange={(next) => onChange({ type: "number", value: next === null ? Number.NaN : next })}
      />
    );
  return (
    <Input.TextArea
      aria-label={label}
      disabled={disabled}
      autoSize={{ minRows: 1, maxRows: 5 }}
      maxLength={2048}
      value={value.value}
      placeholder="Exact text; an empty value is allowed"
      onChange={(event) => onChange({ type: "string", value: event.target.value })}
    />
  );
}

function PredicateRow({
  profile,
  value,
  onChange,
  onRemove,
  label,
  disabled,
}: {
  readonly profile: ValidationProfileVersion;
  readonly value: ObservationEquals;
  readonly onChange: (value: ObservationEquals) => void;
  readonly onRemove: () => void;
  readonly label: string;
  readonly disabled: boolean;
}) {
  const available = getObservationOptions(profile);
  const key = observationRefKey(value.observation);
  const options = available.map((entry) => ({ value: entry.key, label: entry.label }));
  if (!available.some((entry) => entry.key === key))
    options.push({ value: key, label: "Observation unavailable in this version" });
  return (
    <div style={row}>
      <div style={observationColumn}>
        <Select
          aria-label={`${label} observation`}
          style={vertical}
          disabled={disabled}
          showSearch
          optionFilterProp="label"
          value={key}
          options={options}
          onChange={(next) => {
            const selected = available.find((entry) => entry.key === next);
            if (selected)
              onChange({ observation: selected.ref, equals: defaultValue(selected.type) });
          }}
        />
      </div>
      <div style={valueColumn}>
        <ExactValue
          value={value.equals}
          label={`${label} exact value`}
          disabled={disabled}
          onChange={(equals) => onChange({ ...value, equals })}
        />
      </div>
      <Button
        aria-label={`Remove ${label}`}
        title="Remove condition"
        icon={<DeleteOutlined />}
        disabled={disabled}
        onClick={onRemove}
      />
    </div>
  );
}

function SignatureEditor({
  profile,
  value,
  onChange,
  title,
  label,
  disabled,
}: {
  readonly profile: ValidationProfileVersion;
  readonly value: ObservationSignature;
  readonly onChange: (value: ObservationSignature) => void;
  readonly title: string;
  readonly label: string;
  readonly disabled: boolean;
}) {
  const keys = useRowKeys<ObservationEquals>();
  const available = getObservationOptions(profile);
  const add = () => {
    const chosen = available.find(
      (entry) =>
        !value.allOf.some((predicate) => observationRefKey(predicate.observation) === entry.key),
    );
    if (chosen)
      onChange({
        allOf: [...value.allOf, { observation: chosen.ref, equals: defaultValue(chosen.type) }],
      });
  };
  return (
    <Space orientation="vertical" size="small" style={vertical}>
      <Typography.Text strong>{title}</Typography.Text>
      <Typography.Text type="secondary">All conditions below must match exactly.</Typography.Text>
      {value.allOf.map((predicate, index) => (
        <PredicateRow
          key={keys.keyFor(predicate)}
          profile={profile}
          value={predicate}
          disabled={disabled}
          label={`${label} condition ${index + 1}`}
          onChange={(next) => {
            keys.replaceKey(predicate, next);
            onChange({
              allOf: value.allOf.map((entry, position) => (position === index ? next : entry)),
            });
          }}
          onRemove={() =>
            onChange({ allOf: value.allOf.filter((_entry, position) => position !== index) })
          }
        />
      ))}
      <Button
        size="small"
        icon={<PlusOutlined />}
        disabled={disabled || value.allOf.length >= Math.min(16, available.length)}
        onClick={add}
      >
        Add condition
      </Button>
    </Space>
  );
}

function PreconditionsEditor({
  profile,
  value,
  onChange,
  disabled,
}: {
  readonly profile: ValidationProfileVersion;
  readonly value: readonly ReproductionPrecondition[];
  readonly onChange: (value: ReproductionPrecondition[]) => void;
  readonly disabled: boolean;
}) {
  const keys = useRowKeys<ReproductionPrecondition>();
  const checks = getPreconditionChecks(profile);
  const change = (index: number, next: ReproductionPrecondition) => {
    const previous = value[index];
    if (previous) keys.replaceKey(previous, next);
    onChange(value.map((entry, position) => (position === index ? next : entry)));
  };
  const remove = (index: number) =>
    onChange(value.filter((_entry, position) => position !== index));
  return (
    <Space orientation="vertical" size="small" style={vertical}>
      <Typography.Text strong>Preconditions</Typography.Text>
      <Typography.Text type="secondary">
        These controls must hold before either conclusion is valid.
      </Typography.Text>
      {value.map((control, index) => (
        <div key={keys.keyFor(control)} style={{ ...row, paddingBlock: 4 }}>
          <Select
            aria-label={`Precondition ${index + 1} type`}
            style={{ width: 180 }}
            value={control.kind}
            disabled={disabled}
            options={[
              { value: "check_passed", label: "Check passes", disabled: checks.length === 0 },
              { value: "observation_equals", label: "Observation equals" },
            ]}
            onChange={(kind) => {
              if (kind === "check_passed" && checks[0])
                change(index, { kind, checkId: checks[0].id });
              const predicate = firstPredicate(profile);
              if (kind === "observation_equals" && predicate) change(index, { kind, predicate });
            }}
          />
          <div style={{ flex: "1 1 380px", minWidth: 0 }}>
            {control.kind === "check_passed" ? (
              <div style={row}>
                <Select
                  aria-label={`Precondition ${index + 1} check`}
                  disabled={disabled}
                  style={observationColumn}
                  value={control.checkId}
                  options={checks.map((check) => ({ value: check.id, label: check.label }))}
                  onChange={(checkId) => change(index, { kind: "check_passed", checkId })}
                />
                <Button
                  aria-label={`Remove precondition ${index + 1}`}
                  title="Remove precondition"
                  icon={<DeleteOutlined />}
                  disabled={disabled}
                  onClick={() => remove(index)}
                />
              </div>
            ) : (
              <PredicateRow
                profile={profile}
                value={control.predicate}
                label={`precondition ${index + 1}`}
                disabled={disabled}
                onChange={(predicate) => change(index, { kind: "observation_equals", predicate })}
                onRemove={() => remove(index)}
              />
            )}
          </div>
        </div>
      ))}
      <Button
        size="small"
        icon={<PlusOutlined />}
        disabled={disabled || value.length >= 16}
        onClick={() => {
          const check = checks[0];
          const predicate = firstPredicate(profile);
          if (check) onChange([...value, { kind: "check_passed", checkId: check.id }]);
          else if (predicate) onChange([...value, { kind: "observation_equals", predicate }]);
        }}
      >
        Add precondition
      </Button>
    </Space>
  );
}

export function ReproductionEditor({
  profiles,
  selectedProfileIds,
  value,
  onChange,
  defaultClaim,
  disabled,
  sample,
}: ReproductionEditorProps) {
  const choices = getReproductionProfileOptions(profiles, selectedProfileIds).filter(
    (entry) => entry.selected,
  );
  const eligible = choices.filter((entry) => entry.suitable);
  const replace = (id: string, next: IssueReproductionCaseRequest) => {
    if (value)
      onChange({ ...value, cases: value.cases.map((entry) => (entry.id === id ? next : entry)) });
  };
  const resetProfile = (entry: IssueReproductionCaseRequest, profile: ValidationProfileVersion) => {
    const replacement = newCase(profile);
    replace(entry.id, { ...replacement, id: entry.id, context: entry.context });
  };
  return (
    <Card size="small" title="Issue reproduction">
      <Space orientation="vertical" size="middle" style={vertical}>
        <Checkbox
          checked={value !== undefined}
          disabled={disabled}
          onChange={(event) => {
            const first = eligible[0];
            onChange(
              event.target.checked
                ? {
                    schemaVersion: "IssueReproductionRequestV1",
                    claim: defaultClaim,
                    cases: first ? [newCase(first.version)] : [],
                  }
                : undefined,
            );
          }}
        >
          Define observations for this issue
        </Checkbox>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Specify the behavior to reproduce and the observations that confirm it. Each case uses one
          published validation profile.
        </Typography.Paragraph>
        {value !== undefined && (
          <>
            {sample && (
              <Alert
                type="info"
                showIcon
                title="Connected server required"
                description="You can configure cases in this preview. Saving and executing reproduction runs requires a connected server."
              />
            )}
            <Form layout="vertical" disabled={disabled}>
              <Form.Item label="Reported behavior" required style={{ marginBottom: 0 }}>
                <Input.TextArea
                  aria-label="Reported behavior"
                  maxLength={2048}
                  showCount
                  autoSize={{ minRows: 2, maxRows: 6 }}
                  value={value.claim}
                  onChange={(event) => onChange({ ...value, claim: event.target.value })}
                />
              </Form.Item>
            </Form>
            {eligible.length === 0 && (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Select a compatible issue validation profile with UI assertions or declared test output fields. Publish a new profile version if needed."
              />
            )}
            {choices
              .filter(
                (entry) => !entry.suitable && entry.version.workflowKind === "issue_validation",
              )
              .map((entry) => (
                <Alert
                  key={entry.version.profileId}
                  type="warning"
                  showIcon
                  title={entry.version.name}
                  description={entry.reason}
                />
              ))}
            {value.cases.map((entry, index) => {
              const option = profiles.find(
                (candidate) => candidate.version.profileId === entry.profileId,
              );
              const profile = option?.version;
              const selected = selectedProfileIds.includes(entry.profileId);
              const stale = profile !== undefined && profile.id !== entry.expectedProfileVersionId;
              const unavailable =
                profile === undefined
                  ? "This profile is no longer available. Choose another selected profile."
                  : !selected
                    ? "This profile is not included in the run. Include it or choose another profile."
                    : reproductionProfileUnavailableReason(profile);
              const profileChoices = choices
                .filter((candidate) => candidate.suitable)
                .map((candidate) => ({
                  value: candidate.version.profileId,
                  label: `${candidate.version.name} · ${targetLabels[candidate.version.target]} · v${candidate.version.version}`,
                }));
              if (!profileChoices.some((candidate) => candidate.value === entry.profileId))
                profileChoices.push({
                  value: entry.profileId,
                  label: profile?.name ?? "Unavailable profile",
                });
              return (
                <Card
                  key={entry.id}
                  size="small"
                  title={`Reproduction case ${index + 1}`}
                  extra={
                    <Button
                      type="text"
                      danger
                      aria-label={`Remove reproduction case ${index + 1}`}
                      icon={<DeleteOutlined />}
                      disabled={disabled}
                      onClick={() =>
                        onChange({
                          ...value,
                          cases: value.cases.filter((candidate) => candidate.id !== entry.id),
                        })
                      }
                    />
                  }
                >
                  <Space orientation="vertical" size="middle" style={vertical}>
                    <Form layout="vertical" disabled={disabled}>
                      <Form.Item label="Validation profile" required>
                        <Select
                          aria-label={`Reproduction case ${index + 1} profile`}
                          value={entry.profileId}
                          options={profileChoices}
                          onChange={(profileId) => {
                            const next = eligible.find(
                              (candidate) => candidate.version.profileId === profileId,
                            );
                            if (next) resetProfile(entry, next.version);
                          }}
                        />
                        <Typography.Text type="secondary">
                          Changing the profile resets this case's conditions.
                        </Typography.Text>
                      </Form.Item>
                      <Form.Item label="Case context" required style={{ marginBottom: 0 }}>
                        <Input.TextArea
                          aria-label={`Reproduction case ${index + 1} context`}
                          value={entry.context}
                          maxLength={2048}
                          autoSize={{ minRows: 2, maxRows: 5 }}
                          placeholder="Describe the environment, input, or user action exercised by this case."
                          onChange={(event) =>
                            replace(entry.id, { ...entry, context: event.target.value })
                          }
                        />
                      </Form.Item>
                    </Form>
                    {profile && (
                      <div>
                        <Tag>{targetLabels[profile.target]}</Tag>
                        <Typography.Text type="secondary">
                          Published version {profile.version}
                        </Typography.Text>
                      </div>
                    )}
                    {unavailable && (
                      <Alert
                        type="warning"
                        showIcon
                        title="Case profile unavailable"
                        description={unavailable}
                      />
                    )}
                    {stale && profile && (
                      <Alert
                        type="warning"
                        showIcon
                        title="The bound profile version changed"
                        description="This case still expects its previously selected version. Review the current version and rebuild its conditions."
                        action={
                          <Button
                            size="small"
                            disabled={disabled || Boolean(unavailable)}
                            onClick={() => resetProfile(entry, profile)}
                          >
                            Use version {profile.version}
                          </Button>
                        }
                      />
                    )}
                    {profile && !unavailable && !stale && (
                      <>
                        <PreconditionsEditor
                          profile={profile}
                          value={entry.preconditions}
                          disabled={disabled}
                          onChange={(preconditions) =>
                            replace(entry.id, { ...entry, preconditions })
                          }
                        />
                        <SignatureEditor
                          profile={profile}
                          value={entry.presentWhen}
                          disabled={disabled}
                          title="Issue observed when"
                          label={`case ${index + 1} observed`}
                          onChange={(presentWhen) => replace(entry.id, { ...entry, presentWhen })}
                        />
                        <Checkbox
                          checked={entry.absentWhen !== null}
                          disabled={disabled}
                          onChange={(event) =>
                            replace(entry.id, {
                              ...entry,
                              absentWhen: event.target.checked ? { allOf: [] } : null,
                            })
                          }
                        >
                          Define observations that show the issue was absent
                        </Checkbox>
                        {entry.absentWhen !== null ? (
                          <SignatureEditor
                            profile={profile}
                            value={entry.absentWhen}
                            disabled={disabled}
                            title="Issue not observed when"
                            label={`case ${index + 1} absent`}
                            onChange={(absentWhen) => replace(entry.id, { ...entry, absentWhen })}
                          />
                        ) : (
                          <Typography.Text type="secondary">
                            Without an absence condition, a non-matching result remains
                            inconclusive.
                          </Typography.Text>
                        )}
                      </>
                    )}
                  </Space>
                </Card>
              );
            })}
            <Button
              icon={<PlusOutlined />}
              disabled={disabled || eligible.length === 0 || value.cases.length >= 32}
              onClick={() => {
                const profile = eligible[0]?.version;
                if (profile) onChange({ ...value, cases: [...value.cases, newCase(profile)] });
              }}
            >
              Add reproduction case
            </Button>
            <Typography.Text type="secondary">
              {value.cases.length} of 32 cases. Windows, Web, and command-line cases can be included
              in the same run.
            </Typography.Text>
          </>
        )}
      </Space>
    </Card>
  );
}
