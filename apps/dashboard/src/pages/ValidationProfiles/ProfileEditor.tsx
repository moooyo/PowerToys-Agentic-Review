import {
  maximumTestProbeFieldCount,
  type ValidationCommandStep,
  type ValidationProfileVersion,
  type ValidationProfileVersionSummary,
  type WebUiEvidencePolicy,
  type WorkflowKind,
} from "@agentic-review/contracts";
import { Add, Close, ExpandMore } from "@mui/icons-material";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  FormControlLabel,
  IconButton,
  Skeleton,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useConfigurationAvailable } from "@/components/ConfigurationScopeGuard";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { DetailsGrid } from "@/components/ui";
import { configuration } from "@/services/configuration";
import {
  buildProfilePublish,
  configurationErrorMessage,
  isProfileConflict,
  type ProfileFormValues,
  type ProfileProbeField,
  parseProfileConfig,
  profileFormValues,
  profileOutputSchemas,
  profileTargets,
  targetLabels,
  updateProfileProbeFields,
  updateProfileWebTrace,
  webTraceLabels,
  workflowLabels,
} from "./forms";

const stepExample = {
  id: "build-app",
  name: "Build application",
  command: {
    executable: "dotnet",
    args: ["build", "--no-restore"],
    workingDirectory: ".",
    environment: [],
  },
  timeoutMs: 300_000,
  required: true,
};

function ProbeFieldsEditor({
  step,
  disabled,
  onApply,
  onClose,
}: {
  step: ValidationCommandStep;
  disabled: boolean;
  onApply: (fields: ProfileProbeField[]) => void;
  onClose: () => void;
}) {
  const [fields, setFields] = useState(() =>
    (step.probeOutput?.fields ?? []).map((value, key) => ({ key, value: structuredClone(value) })),
  );
  const nextKey = useRef(fields.length);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const edit = (key: number, value: Partial<ProfileProbeField>) => {
    if (disabled) return;
    setFields((current) =>
      current.map((field) =>
        field.key === key ? { ...field, value: { ...field.value, ...value } } : field,
      ),
    );
    setError(undefined);
    setFieldErrors({});
  };
  const apply = () => {
    if (disabled) return;
    const errors: Record<string, string> = {};
    for (const field of fields) {
      const value = field.value;
      if (!value.id) errors[`${field.key}.id`] = "Enter a field ID.";
      else if (value.id.length > 128) errors[`${field.key}.id`] = "Use at most 128 characters.";
      else if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.id))
        errors[`${field.key}.id`] =
          "Start with a letter or number; use letters, numbers, ., _, :, or -.";
      if (!["boolean", "string", "number"].includes(value.type))
        errors[`${field.key}.type`] = "Choose a value type.";
      if (!value.description.trim())
        errors[`${field.key}.description`] = "Describe what this field reports.";
      else if (value.description.length > 2_048)
        errors[`${field.key}.description`] = "Use at most 2,048 characters.";
      else if (value.description.includes(String.fromCharCode(0)))
        errors[`${field.key}.description`] = "Remove the null character.";
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    if (fields.length > maximumTestProbeFieldCount) {
      setError(`Declare at most ${maximumTestProbeFieldCount} fields.`);
      return;
    }
    if (new Set(fields.map((field) => field.value.id)).size !== fields.length) {
      setError("Use a unique field ID within this test command.");
      return;
    }
    try {
      onApply(fields.map((field) => field.value));
    } catch (failure) {
      setError(configurationErrorMessage(failure));
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="profile-observables-title"
    >
      <DialogTitle id="profile-observables-title">Test observables · {step.name}</DialogTitle>
      <DialogContent>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Declare the values this test reports. Issue reproduction cases can compare these values
          with the expected result. Changes stay in this draft until you publish.
        </Typography>
        <Typography sx={{ mb: 2 }}>
          Test command: <code>{step.id}</code>
        </Typography>
        {error && (
          <Alert severity="error" className="validation-profiles-notice">
            {error}
          </Alert>
        )}
        {fields.map((field, index) => (
          <Box className="validation-profiles-probe-field" key={field.key}>
            <div className="validation-profiles-probe-heading">
              <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
                Field {index + 1}
              </Typography>
              <Button
                disabled={disabled}
                aria-label={`Remove field ${index + 1}`}
                onClick={() => {
                  if (disabled) return;
                  setFields((current) =>
                    current.filter((candidate) => candidate.key !== field.key),
                  );
                  setError(undefined);
                  setFieldErrors({});
                }}
              >
                Remove
              </Button>
            </div>
            <div className="validation-profiles-form-grid">
              <TextField
                label="Field ID"
                value={field.value.id}
                disabled={disabled}
                slotProps={{ htmlInput: { maxLength: 128 } }}
                placeholder="e.g. saved-title"
                onChange={(event) => edit(field.key, { id: event.target.value })}
                error={Boolean(fieldErrors[`${field.key}.id`])}
                helperText={fieldErrors[`${field.key}.id`]}
              />
              <TextField
                select
                label="Value type"
                value={field.value.type}
                disabled={disabled}
                slotProps={{ select: { native: true } }}
                onChange={(event) =>
                  edit(field.key, { type: event.target.value as ProfileProbeField["type"] })
                }
                error={Boolean(fieldErrors[`${field.key}.type`])}
                helperText={fieldErrors[`${field.key}.type`]}
              >
                <option value="boolean">Boolean (true / false)</option>
                <option value="string">String (text)</option>
                <option value="number">Number</option>
              </TextField>
            </div>
            <TextField
              fullWidth
              multiline
              minRows={2}
              maxRows={5}
              sx={{ mt: 2 }}
              label="Description"
              value={field.value.description}
              disabled={disabled}
              slotProps={{ htmlInput: { maxLength: 2_048 } }}
              placeholder="e.g. The title read after saving and reopening the document."
              onChange={(event) => edit(field.key, { description: event.target.value })}
              error={Boolean(fieldErrors[`${field.key}.description`])}
              helperText={fieldErrors[`${field.key}.description`]}
            />
          </Box>
        ))}
        {fields.length === 0 && (
          <Typography color="text.secondary" sx={{ mb: 2 }}>
            No observable fields declared. Applying an empty list removes the declaration.
          </Typography>
        )}
        <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
          <Button
            variant="outlined"
            startIcon={<Add />}
            disabled={disabled || fields.length >= maximumTestProbeFieldCount}
            onClick={() => {
              if (disabled || fields.length >= maximumTestProbeFieldCount) return;
              const key = nextKey.current++;
              setFields((current) => [
                ...current,
                { key, value: { id: "", description: "", type: "boolean" } },
              ]);
              setError(undefined);
              setFieldErrors({});
            }}
          >
            Add field
          </Button>
          <Typography color="text.secondary" variant="body2">
            {fields.length} / {maximumTestProbeFieldCount} fields
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={disabled} onClick={apply}>
          Apply fields
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function ProfileEditor({
  repositoryId,
  source,
  onClose,
  onPublished,
}: {
  repositoryId: string;
  source?: ValidationProfileVersionSummary;
  onClose: () => void;
  onPublished: (profile: ValidationProfileVersion) => void;
}) {
  const available = useConfigurationAvailable();
  const access = useOperatorAccess(repositoryId);
  const canConfigure = available && access.can("configure");
  const { control, watch, reset, getValues, setValue, trigger, handleSubmit } =
    useForm<ProfileFormValues>({ defaultValues: profileFormValues(), mode: "onChange" });
  const [baseline, setBaseline] = useState<ValidationProfileVersion | undefined>();
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [editingStep, setEditingStep] = useState<ValidationCommandStep>();
  const workflowKind = watch("workflowKind");
  const target = watch("target");
  const configJson = watch("configJson");
  const configDraft = useMemo(() => {
    try {
      return parseProfileConfig(configJson, workflowKind, target);
    } catch {
      return undefined;
    }
  }, [configJson, workflowKind, target]);
  const latestQuery = useQuery({
    queryKey: ["validation-profiles", repositoryId, "editor", source?.profileId],
    queryFn: async () => {
      if (!source) throw new Error("Select a profile before loading its latest version.");
      const result = await configuration.listProfileVersions(repositoryId, source.profileId, {
        page: 1,
        pageSize: 1,
      });
      const latest = result.items[0];
      if (!latest)
        throw new Error("This profile has no published version. Refresh the profile list.");
      return configuration.getProfileVersion(repositoryId, source.profileId, latest.id);
    },
    enabled: source !== undefined,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  useEffect(() => {
    if (latestQuery.data && !latestQuery.isFetching && !latestQuery.isError && !baseline) {
      setBaseline(latestQuery.data);
      reset(profileFormValues(latestQuery.data));
    }
  }, [baseline, reset, latestQuery.data, latestQuery.isFetching, latestQuery.isError]);

  const reloadLatest = async () => {
    try {
      const result = await latestQuery.refetch({ throwOnError: true });
      if (!result.data) return;
      setBaseline(result.data);
      reset(profileFormValues(result.data));
      setEditingStep(undefined);
      setError(null);
      setConflict(false);
    } catch (failure) {
      setError(configurationErrorMessage(failure));
    }
  };
  const publish = async (values: ProfileFormValues) => {
    if (!canConfigure || saveInFlight.current || saving) return;
    if (conflict || (source && (!baseline || latestQuery.isFetching || latestQuery.isError)))
      return;
    saveInFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await configuration.publishProfile(
        repositoryId,
        buildProfilePublish(values, repositoryId, baseline),
      );
      onPublished(result);
    } catch (failure) {
      setConflict(isProfileConflict(failure));
      setError(configurationErrorMessage(failure));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };
  const ready = !source || baseline !== undefined;
  const updateConfig = (next: string) => {
    if (!canConfigure || saveInFlight.current || saving || conflict)
      throw new Error("This draft cannot be edited now.");
    setValue("configJson", next, { shouldValidate: true, shouldDirty: true });
  };

  const draftDisabled = !canConfigure || saving || conflict;
  const closeEditor = () => {
    if (!saveInFlight.current && !saving) onClose();
  };
  const validateConfig = (value: string) => {
    try {
      parseProfileConfig(value, getValues("workflowKind"), getValues("target"));
      return true;
    } catch (failure) {
      return configurationErrorMessage(failure);
    }
  };

  return (
    <Drawer
      open
      anchor="right"
      onClose={closeEditor}
      slotProps={{
        paper: {
          sx: { width: { xs: "100%", md: 760 }, maxWidth: "100%" },
          role: "dialog",
          "aria-labelledby": "profile-editor-title",
        },
      }}
    >
      <Stack
        direction="row"
        spacing={2}
        sx={{
          px: 3,
          py: 2,
          borderBottom: 1,
          borderColor: "divider",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Typography variant="h6" component="h2" id="profile-editor-title">
          {source ? `New version · ${source.name}` : "Create validation profile"}
        </Typography>
        <IconButton aria-label="Close profile editor" disabled={saving} onClick={closeEditor}>
          <Close />
        </IconButton>
      </Stack>
      <Box sx={{ p: { xs: 2, sm: 3 }, overflowY: "auto", flex: 1 }}>
        {!ready && (latestQuery.isPending || latestQuery.isFetching) && (
          <Stack spacing={2} aria-label="Loading latest version">
            <Skeleton height={60} />
            <Skeleton variant="rounded" height={400} />
          </Stack>
        )}
        {!ready && latestQuery.isError && (
          <Alert
            severity="error"
            action={
              <Button color="inherit" onClick={reloadLatest}>
                Try again
              </Button>
            }
          >
            <AlertTitle>Could not load the latest version</AlertTitle>
            {configurationErrorMessage(latestQuery.error)}
          </Alert>
        )}
        {ready && (
          <>
            {!access.allows("configure") && (
              <Alert className="validation-profiles-notice" severity="warning">
                <AlertTitle>Configuration permission required</AlertTitle>Your draft is preserved.
                Repository configuration permission is required to publish this profile.
              </Alert>
            )}
            <Typography color="text.secondary" sx={{ mb: 3 }}>
              Published versions are read-only.{" "}
              {baseline
                ? "This creates version " +
                  (baseline.version + 1) +
                  " from version " +
                  baseline.version +
                  ". "
                : ""}
              Publishing saves configuration; it does not run tests or change the repository
              binding.
            </Typography>
            {latestQuery.isError && !conflict && (
              <Alert
                className="validation-profiles-notice"
                severity="error"
                action={
                  <Button
                    color="inherit"
                    loading={latestQuery.isFetching}
                    onClick={() => void latestQuery.refetch()}
                  >
                    Retry connection
                  </Button>
                }
              >
                <AlertTitle>Could not refresh the latest version</AlertTitle>
                <p>{configurationErrorMessage(latestQuery.error)}</p>
                <p>Your draft has been preserved. Retry the connection before publishing.</p>
              </Alert>
            )}
            {conflict ? (
              <Alert
                className="validation-profiles-notice"
                severity="warning"
                action={
                  <Button color="inherit" loading={latestQuery.isFetching} onClick={reloadLatest}>
                    Reload latest version
                  </Button>
                }
              >
                <AlertTitle>A newer version was published</AlertTitle>
                <p>{error}</p>
                <p>
                  Reload the latest version, then reapply your changes. Reloading replaces this
                  draft.
                </p>
              </Alert>
            ) : error ? (
              <Alert className="validation-profiles-notice" severity="error">
                <AlertTitle>Could not publish profile</AlertTitle>
                {error}
              </Alert>
            ) : null}
            <Box
              component="form"
              id="profile-editor-form"
              noValidate
              onSubmit={handleSubmit(publish)}
            >
              <Stack spacing={3}>
                <Typography variant="subtitle1" component="h3">
                  Profile setup
                </Typography>
                <Controller
                  name="name"
                  control={control}
                  rules={{
                    validate: (value) => value.trim().length > 0 || "Enter a profile name.",
                    maxLength: { value: 128, message: "Use at most 128 characters." },
                  }}
                  render={({ field: { ref, ...field }, fieldState }) => (
                    <TextField
                      {...field}
                      fullWidth
                      label="Profile name"
                      disabled={draftDisabled}
                      slotProps={{ htmlInput: { ref, maxLength: 128 } }}
                      placeholder="e.g. Windows build and unit tests"
                      error={Boolean(fieldState.error)}
                      helperText={fieldState.error?.message}
                    />
                  )}
                />
                <div className="validation-profiles-form-grid">
                  <Controller
                    name="workflowKind"
                    control={control}
                    rules={{ required: true }}
                    render={({ field: { ref, ...field } }) => (
                      <TextField
                        {...field}
                        fullWidth
                        select
                        label="Workflow"
                        disabled={draftDisabled || Boolean(source)}
                        helperText={source ? "Fixed for every version of this profile." : undefined}
                        slotProps={{ select: { native: true }, htmlInput: { ref } }}
                        onChange={(event) => {
                          field.onChange(event);
                          const supported = profileTargets(event.target.value as WorkflowKind);
                          const nextTarget = supported[0];
                          if (nextTarget && !supported.includes(getValues("target")))
                            setValue("target", nextTarget, { shouldDirty: true });
                          void trigger("configJson");
                        }}
                      >
                        {Object.entries(workflowLabels).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </TextField>
                    )}
                  />
                  <Controller
                    name="target"
                    control={control}
                    rules={{ required: true }}
                    render={({ field: { ref, ...field } }) => (
                      <TextField
                        {...field}
                        fullWidth
                        select
                        label="Execution target"
                        disabled={draftDisabled || Boolean(source)}
                        helperText={source ? "Fixed for every version of this profile." : undefined}
                        slotProps={{ select: { native: true }, htmlInput: { ref } }}
                        onChange={(event) => {
                          field.onChange(event);
                          void trigger("configJson");
                        }}
                      >
                        {profileTargets(workflowKind).map((value) => (
                          <option key={value} value={value}>
                            {targetLabels[value]}
                          </option>
                        ))}
                      </TextField>
                    )}
                  />
                </div>
                <DetailsGrid
                  columns={1}
                  items={[
                    {
                      label: "Output schema",
                      value: <code>{profileOutputSchemas[workflowKind]}</code>,
                    },
                  ]}
                />
                {workflowKind === "issue_triage" ? (
                  <Alert severity="info">
                    <AlertTitle>Static triage only</AlertTitle>Issue triage cannot execute commands.
                    Keep setup, build, test, launch, and cleanup arrays empty.
                  </Alert>
                ) : workflowKind === "pr_ui" || workflowKind === "issue_validation" ? (
                  <Alert severity="info">
                    <AlertTitle>A matching validation driver is required</AlertTitle>Workers need a
                    configured driver for this workflow and execution target before they can execute
                    this profile. Publishing this configuration does not mean validation has passed.
                  </Alert>
                ) : null}
                <Box>
                  <Controller
                    name="required"
                    control={control}
                    render={({ field }) => (
                      <FormControlLabel
                        label="Required profile"
                        control={
                          <Switch
                            checked={field.value}
                            onChange={(_, value) => field.onChange(value)}
                            onBlur={field.onBlur}
                            name={field.name}
                            slotProps={{ input: { ref: field.ref } }}
                            disabled={draftDisabled}
                          />
                        }
                      />
                    )}
                  />
                  <Typography color="text.secondary" variant="body2">
                    Include this profile as a required part of the workflow when its repository
                    binding is enabled.
                  </Typography>
                </Box>
                {workflowKind !== "issue_triage" && (
                  <Box>
                    <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 500 }}>
                      Test observables
                    </Typography>
                    <Typography color="text.secondary" sx={{ mb: 1 }}>
                      Declare values reported by test commands so Issue reproduction cases can
                      compare them with expected results. Each command can declare up to 32 boolean,
                      string, or number fields.
                    </Typography>
                    {!configDraft ? (
                      <Typography color="text.secondary">
                        Fix the execution configuration JSON below to edit test observables.
                      </Typography>
                    ) : configDraft.test.length === 0 ? (
                      <Typography color="text.secondary">
                        Add a test command in the execution configuration to declare observable
                        fields.
                      </Typography>
                    ) : (
                      configDraft.test.map((step) => (
                        <div className="validation-profiles-probe-command" key={step.id}>
                          <div>
                            <Typography sx={{ fontWeight: 500 }}>{step.name}</Typography>
                            <div className="validation-profiles-secondary">
                              <code>{step.id}</code>
                            </div>
                            <Stack
                              direction="row"
                              spacing={0.5}
                              useFlexGap
                              sx={{ flexWrap: "wrap" }}
                            >
                              {step.probeOutput?.fields.map((field) => (
                                <Chip
                                  variant="outlined"
                                  key={field.id}
                                  label={`${field.id} · ${field.type}`}
                                />
                              )) ?? (
                                <Typography color="text.secondary">No fields declared</Typography>
                              )}
                            </Stack>
                          </div>
                          <Button
                            variant="outlined"
                            disabled={draftDisabled}
                            onClick={() => {
                              if (!draftDisabled) setEditingStep(step);
                            }}
                          >
                            {step.probeOutput ? "Edit fields" : "Add fields"}
                          </Button>
                        </div>
                      ))
                    )}
                  </Box>
                )}
                <Typography variant="subtitle1" component="h3">
                  Execution configuration
                </Typography>
                {target === "web" && (
                  <TextField
                    fullWidth
                    select
                    label="Browser trace capture"
                    value={configDraft?.ui?.target === "web" ? configDraft.ui.evidence.trace : ""}
                    slotProps={{ select: { native: true } }}
                    disabled={draftDisabled || configDraft?.ui?.target !== "web"}
                    helperText="On failure keeps traces for failed scenarios; Always keeps every scenario trace. Off skips browser traces and keeps the configured screenshots. Issue reproduction requires Off."
                    onChange={(event) => {
                      try {
                        updateConfig(
                          updateProfileWebTrace(
                            getValues("configJson"),
                            workflowKind,
                            target,
                            event.target.value as WebUiEvidencePolicy["trace"],
                          ),
                        );
                      } catch (failure) {
                        setError(configurationErrorMessage(failure));
                      }
                    }}
                  >
                    <option value="" disabled>
                      {configDraft
                        ? "Add Web UI scenarios to choose trace capture"
                        : "Fix the configuration JSON to choose trace capture"}
                    </option>
                    {Object.entries(webTraceLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </TextField>
                )}
                <Controller
                  name="configJson"
                  control={control}
                  rules={{ validate: validateConfig }}
                  render={({ field: { ref, ...field }, fieldState }) => (
                    <TextField
                      {...field}
                      fullWidth
                      multiline
                      minRows={16}
                      maxRows={28}
                      label="Execution configuration (JSON)"
                      disabled={draftDisabled}
                      slotProps={{
                        htmlInput: {
                          ref,
                          spellCheck: false,
                          "aria-label": "Execution configuration JSON",
                        },
                      }}
                      sx={{
                        "& textarea": {
                          fontFamily: '"Roboto Mono", Consolas, monospace',
                          fontSize: 14,
                          lineHeight: "24px",
                        },
                      }}
                      error={Boolean(fieldState.error)}
                      helperText={
                        fieldState.error?.message ??
                        "ValidationProfileV1 · All five stage arrays, capability names, and both timeouts are required."
                      }
                    />
                  )}
                />
                <Accordion elevation={0} disableGutters sx={{ bgcolor: "background.default" }}>
                  <AccordionSummary
                    expandIcon={<ExpandMore />}
                    aria-controls="profile-schema-help"
                    id="profile-schema-heading"
                  >
                    Configuration schema and command example
                  </AccordionSummary>
                  <AccordionDetails id="profile-schema-help">
                    <Stack spacing={2}>
                      <Typography>
                        Use setup, build, test, launch, and cleanup arrays with at most 32 steps per
                        stage. Each step needs a unique id, a name, a command, timeoutMs, and
                        required.
                      </Typography>
                      <Typography>
                        Commands use an executable and an args array. workingDirectory is a relative
                        workspace path such as "." and cannot escape the workspace. environment
                        entries use {"{ name, value }"} or {"{ name, secretRef }"}; credentials must
                        use secretRef.
                      </Typography>
                      <pre className="validation-profiles-json">
                        {JSON.stringify(stepExample, null, 2)}
                      </pre>
                      <Typography>
                        hardTimeoutMs, noProgressTimeoutMs, and each step timeoutMs must be whole
                        milliseconds between 1,000 and 86,400,000. Neither the no-progress timeout
                        nor a step timeout may exceed the hard timeout. requiredCapabilities is an
                        array of unique capability names. Configuration is limited to 262,144 UTF-8
                        bytes.
                      </Typography>
                      <Typography>
                        Test commands can declare optional probeOutput fields with a unique id,
                        description, and type (boolean, string, or number). Use the test observables
                        editor above to add or remove these declarations. Other command stages
                        cannot declare probe output.
                      </Typography>
                      <Typography>
                        UI workflows can add an "ui" object with schemaVersion "UiScenariosV1". Its
                        target must match this profile. Reference a persistent launch step, define
                        readiness and reset behavior, and add named scenarios with required
                        assertions. Web scenarios use managed loopback navigation and exact role or
                        test ID locators; Windows scenarios stay inside the launched process tree.
                        Configure evidence capture explicitly. Legacy profiles without scenarios
                        remain readable but cannot establish UI execution readiness.
                      </Typography>
                    </Stack>
                  </AccordionDetails>
                </Accordion>
              </Stack>
            </Box>
            {editingStep && (
              <ProbeFieldsEditor
                step={editingStep}
                disabled={draftDisabled}
                onClose={() => setEditingStep(undefined)}
                onApply={(fields) => {
                  updateConfig(
                    updateProfileProbeFields(
                      getValues("configJson"),
                      workflowKind,
                      target,
                      editingStep.id,
                      fields,
                    ),
                  );
                  setEditingStep(undefined);
                }}
              />
            )}
          </>
        )}
      </Box>
      <Stack
        direction="row"
        spacing={1}
        sx={{ px: 3, py: 2, borderTop: 1, borderColor: "divider", justifyContent: "flex-end" }}
      >
        <Button disabled={saving} onClick={closeEditor}>
          Cancel
        </Button>
        <Button
          variant="contained"
          loading={saving}
          disabled={
            !canConfigure ||
            !ready ||
            conflict ||
            latestQuery.isFetching ||
            (Boolean(source) && latestQuery.isError)
          }
          onClick={handleSubmit(publish)}
        >
          {source ? "Publish new version" : "Publish profile"}
        </Button>
      </Stack>
    </Drawer>
  );
}
