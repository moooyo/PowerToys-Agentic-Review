import type {
  IssueReproductionCaseRequest,
  IssueReproductionRequestV1,
  ObservationEquals,
  ObservationSignature,
  ObservationValue,
  ReproductionPrecondition,
  ValidationProfileVersion,
} from "@agentic-review/contracts";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/ui";
import { targetLabels } from "@/pages/ValidationProfiles/forms";
import type { RunProfileOption } from "./helpers";
import {
  getObservationOptions,
  getPreconditionChecks,
  getReproductionProfileOptions,
  observationRefKey,
  observationValueFromInput,
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

const row = { display: "flex", gap: 16, flexWrap: "wrap" as const, alignItems: "start" };
const observationColumn = { flex: "2 1 280px", minWidth: 0 };
const valueColumn = { flex: "1 1 220px", minWidth: 0 };

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
      <TextField
        size="medium"
        select
        label="Exact value"
        slotProps={{ select: { SelectDisplayProps: { "aria-label": label } } }}
        value={value.value ? "true" : "false"}
        disabled={disabled}
        fullWidth
        onChange={(event) => onChange({ type: "boolean", value: event.target.value === "true" })}
      >
        <MenuItem value="true">True</MenuItem>
        <MenuItem value="false">False</MenuItem>
      </TextField>
    );
  if (value.type === "number")
    return (
      <NumericExactValue
        label={label}
        disabled={disabled}
        value={value.value}
        onChange={(next) => onChange({ type: "number", value: next })}
      />
    );
  return (
    <TextField
      size="medium"
      label="Exact value"
      disabled={disabled}
      fullWidth
      multiline
      minRows={1}
      maxRows={5}
      slotProps={{ htmlInput: { maxLength: 2048, "aria-label": label } }}
      value={value.value}
      placeholder="Exact text; an empty value is allowed"
      onChange={(event) => onChange({ type: "string", value: event.target.value })}
    />
  );
}

function NumericExactValue({
  value,
  onChange,
  label,
  disabled,
}: {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly label: string;
  readonly disabled: boolean;
}) {
  const [draft, setDraft] = useState(() => (Number.isFinite(value) ? String(value) : ""));
  useEffect(() => {
    if (Number.isFinite(value) && Number(draft) !== value) setDraft(String(value));
  }, [draft, value]);
  return (
    <TextField
      size="medium"
      label="Exact value"
      disabled={disabled}
      fullWidth
      slotProps={{ htmlInput: { inputMode: "decimal", "aria-label": label } }}
      value={draft}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        try {
          const parsed = observationValueFromInput("number", next);
          if (parsed.type === "number") onChange(parsed.value);
        } catch {
          onChange(Number.NaN);
        }
      }}
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
    <fieldset style={{ ...row, border: 0, padding: 0, margin: 0, minWidth: 0 }} aria-label={label}>
      <div style={observationColumn}>
        <Autocomplete
          size="medium"
          fullWidth
          disableClearable
          disabled={disabled}
          value={options.find((option) => option.value === key)}
          options={options}
          isOptionEqualToValue={(option, selected) => option.value === selected.value}
          getOptionLabel={(option) => option.label}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Observation"
              slotProps={{
                ...params.slotProps,
                htmlInput: { ...params.slotProps.htmlInput, "aria-label": `${label} observation` },
              }}
            />
          )}
          onChange={(_event, next) => {
            const selected = available.find((entry) => entry.key === next.value);
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
      <IconButton
        aria-label={`Remove ${label}`}
        title="Remove condition"
        disabled={disabled}
        onClick={onRemove}
        sx={{ width: 40, height: 40, mt: 1 }}
      >
        <DeleteOutlinedIcon />
      </IconButton>
    </fieldset>
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
    <Stack spacing={2}>
      <Typography variant="subtitle1" component="h5" sx={{ fontWeight: 500 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        All conditions below must match exactly.
      </Typography>
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
        size="medium"
        startIcon={<AddIcon />}
        sx={{ alignSelf: "flex-start" }}
        disabled={disabled || value.allOf.length >= Math.min(16, available.length)}
        onClick={add}
      >
        Add condition
      </Button>
    </Stack>
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
    <Stack spacing={2}>
      <Typography variant="subtitle1" component="h5" sx={{ fontWeight: 500 }}>
        Preconditions
      </Typography>
      <Typography variant="body2" color="text.secondary">
        These controls must hold before either conclusion is valid.
      </Typography>
      {value.map((control, index) => (
        <div key={keys.keyFor(control)} style={{ ...row, paddingBlock: 4 }}>
          <TextField
            size="medium"
            select
            label="Condition type"
            slotProps={{
              select: { SelectDisplayProps: { "aria-label": `Precondition ${index + 1} type` } },
            }}
            style={{ flex: "1 1 220px", minWidth: 0 }}
            value={control.kind}
            disabled={disabled}
            onChange={(event) => {
              const kind = event.target.value;
              if (kind === "check_passed" && checks[0])
                change(index, { kind, checkId: checks[0].id });
              const predicate = firstPredicate(profile);
              if (kind === "observation_equals" && predicate) change(index, { kind, predicate });
            }}
          >
            <MenuItem value="check_passed" disabled={checks.length === 0}>
              Check passes
            </MenuItem>
            <MenuItem value="observation_equals">Observation equals</MenuItem>
          </TextField>
          <div style={{ flex: "1 1 380px", minWidth: 0 }}>
            {control.kind === "check_passed" ? (
              <div style={row}>
                <TextField
                  size="medium"
                  select
                  label="Required check"
                  slotProps={{
                    select: {
                      SelectDisplayProps: { "aria-label": `Precondition ${index + 1} check` },
                    },
                  }}
                  disabled={disabled}
                  style={observationColumn}
                  value={control.checkId}
                  onChange={(event) =>
                    change(index, { kind: "check_passed", checkId: event.target.value })
                  }
                >
                  {checks.map((check) => (
                    <MenuItem key={check.id} value={check.id}>
                      {check.label}
                    </MenuItem>
                  ))}
                </TextField>
                <IconButton
                  aria-label={`Remove precondition ${index + 1}`}
                  title="Remove precondition"
                  disabled={disabled}
                  onClick={() => remove(index)}
                  sx={{ width: 40, height: 40, mt: 1 }}
                >
                  <DeleteOutlinedIcon />
                </IconButton>
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
        size="medium"
        startIcon={<AddIcon />}
        sx={{ alignSelf: "flex-start" }}
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
    </Stack>
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
    <Stack component="section" aria-label="Issue reproduction" spacing={3}>
      <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 500 }}>
        Issue reproduction
      </Typography>
      <FormControlLabel
        control={
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
          />
        }
        label="Define observations for this issue"
      />
      <Typography variant="body2" color="text.secondary">
        Specify the behavior to reproduce and the observations that confirm it. Each case uses one
        published validation profile.
      </Typography>
      {value !== undefined && (
        <>
          {sample && (
            <Alert severity="info">
              <AlertTitle>Connected server required</AlertTitle>
              You can configure cases in this preview. Saving and executing reproduction runs
              requires a connected server.
            </Alert>
          )}
          <TextField
            size="medium"
            label="Reported behavior"
            required
            fullWidth
            disabled={disabled}
            multiline
            minRows={2}
            maxRows={6}
            slotProps={{ htmlInput: { maxLength: 2048, "aria-label": "Reported behavior" } }}
            helperText={`${value.claim.length} / 2048`}
            value={value.claim}
            onChange={(event) => onChange({ ...value, claim: event.target.value })}
          />
          {eligible.length === 0 && (
            <EmptyState
              title="No compatible profiles selected"
              description="Select a compatible issue validation profile with UI assertions or declared test output fields. Publish a new profile version if needed."
            />
          )}
          {choices
            .filter((entry) => !entry.suitable && entry.version.workflowKind === "issue_validation")
            .map((entry) => (
              <Alert key={entry.version.profileId} severity="warning">
                <AlertTitle>{entry.version.name}</AlertTitle>
                {entry.reason}
              </Alert>
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
              <Box
                key={entry.id}
                component="section"
                aria-label={`Reproduction case ${index + 1}`}
                sx={{ borderTop: 1, borderColor: "divider", pt: 3 }}
              >
                <Stack
                  direction="row"
                  spacing={2}
                  sx={{ alignItems: "center", justifyContent: "space-between", mb: 3 }}
                >
                  <Typography variant="subtitle1" component="h4" sx={{ fontWeight: 500 }}>
                    Reproduction case {index + 1}
                  </Typography>
                  <IconButton
                    color="error"
                    aria-label={`Remove reproduction case ${index + 1}`}
                    disabled={disabled}
                    sx={{ width: 40, height: 40 }}
                    onClick={() =>
                      onChange({
                        ...value,
                        cases: value.cases.filter((candidate) => candidate.id !== entry.id),
                      })
                    }
                  >
                    <DeleteOutlinedIcon />
                  </IconButton>
                </Stack>
                <Stack spacing={3}>
                  <TextField
                    size="medium"
                    select
                    label="Validation profile"
                    required
                    fullWidth
                    disabled={disabled}
                    slotProps={{
                      select: {
                        SelectDisplayProps: {
                          "aria-label": `Reproduction case ${index + 1} profile`,
                        },
                      },
                    }}
                    value={entry.profileId}
                    helperText="Changing the profile resets this case's conditions."
                    onChange={(event) => {
                      const profileId = event.target.value;
                      const next = eligible.find(
                        (candidate) => candidate.version.profileId === profileId,
                      );
                      if (next) resetProfile(entry, next.version);
                    }}
                  >
                    {profileChoices.map((choice) => (
                      <MenuItem key={choice.value} value={choice.value}>
                        {choice.label}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    size="medium"
                    label="Case context"
                    required
                    fullWidth
                    disabled={disabled}
                    multiline
                    minRows={2}
                    maxRows={5}
                    slotProps={{
                      htmlInput: {
                        maxLength: 2048,
                        "aria-label": `Reproduction case ${index + 1} context`,
                      },
                    }}
                    value={entry.context}
                    placeholder="Describe the environment, input, or user action exercised by this case."
                    onChange={(event) =>
                      replace(entry.id, { ...entry, context: event.target.value })
                    }
                  />
                  {profile && (
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                      <Chip size="medium" label={targetLabels[profile.target]} />
                      <Typography variant="body2" color="text.secondary">
                        Published version {profile.version}
                      </Typography>
                    </Stack>
                  )}
                  {unavailable && (
                    <Alert severity="warning">
                      <AlertTitle>Case profile unavailable</AlertTitle>
                      {unavailable}
                    </Alert>
                  )}
                  {stale && profile && (
                    <Alert
                      severity="warning"
                      action={
                        <Button
                          size="medium"
                          disabled={disabled || Boolean(unavailable)}
                          onClick={() => resetProfile(entry, profile)}
                        >
                          Use version {profile.version}
                        </Button>
                      }
                    >
                      <AlertTitle>The bound profile version changed</AlertTitle>
                      This case still expects its previously selected version. Review the current
                      version and rebuild its conditions.
                    </Alert>
                  )}
                  {profile && !unavailable && !stale && (
                    <>
                      <PreconditionsEditor
                        profile={profile}
                        value={entry.preconditions}
                        disabled={disabled}
                        onChange={(preconditions) => replace(entry.id, { ...entry, preconditions })}
                      />
                      <SignatureEditor
                        profile={profile}
                        value={entry.presentWhen}
                        disabled={disabled}
                        title="Issue observed when"
                        label={`case ${index + 1} observed`}
                        onChange={(presentWhen) => replace(entry.id, { ...entry, presentWhen })}
                      />
                      <FormControlLabel
                        control={
                          <Checkbox
                            checked={entry.absentWhen !== null}
                            disabled={disabled}
                            onChange={(event) =>
                              replace(entry.id, {
                                ...entry,
                                absentWhen: event.target.checked ? { allOf: [] } : null,
                              })
                            }
                          />
                        }
                        label="Define observations that show the issue was absent"
                      />
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
                        <Typography variant="body2" color="text.secondary">
                          Without an absence condition, a non-matching result remains inconclusive.
                        </Typography>
                      )}
                    </>
                  )}
                </Stack>
              </Box>
            );
          })}
          <Button
            variant="outlined"
            size="medium"
            startIcon={<AddIcon />}
            sx={{ alignSelf: "flex-start" }}
            disabled={disabled || eligible.length === 0 || value.cases.length >= 32}
            onClick={() => {
              const profile = eligible[0]?.version;
              if (profile) onChange({ ...value, cases: [...value.cases, newCase(profile)] });
            }}
          >
            Add reproduction case
          </Button>
          <Typography variant="body2" color="text.secondary">
            {value.cases.length} of 32 cases. Windows, Web, and command-line cases can be included
            in the same run.
          </Typography>
        </>
      )}
    </Stack>
  );
}
