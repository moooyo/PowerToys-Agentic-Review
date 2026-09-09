import {
  maximumTestProbeFieldCount,
  type ValidationCommandStep,
  type ValidationProfileVersion,
  type ValidationProfileVersionSummary,
} from "@agentic-review/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Collapse,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Skeleton,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { useConfigurationAvailable } from "@/components/ConfigurationScopeGuard";
import { useOperatorAccess } from "@/components/OperatorAccess";
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
  const [form] = Form.useForm<{ fields: ProfileProbeField[] }>();
  const [error, setError] = useState<string>();
  return (
    <Modal
      open
      title={`Test observables · ${step.name}`}
      width={680}
      styles={{ body: { maxHeight: "65vh", overflowY: "auto" } }}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="Apply fields"
      okButtonProps={{ disabled }}
    >
      <Typography.Paragraph type="secondary">
        Declare the values this test reports. Issue reproduction cases can compare these values with
        the expected result. Changes stay in this draft until you publish.
      </Typography.Paragraph>
      <Typography.Paragraph>
        Test command: <Typography.Text code>{step.id}</Typography.Text>
      </Typography.Paragraph>
      {error && (
        <Alert type="error" showIcon title={error} className="validation-profiles-notice" />
      )}
      <Form
        form={form}
        layout="vertical"
        disabled={disabled}
        initialValues={{ fields: structuredClone(step.probeOutput?.fields ?? []) }}
        onValuesChange={() => setError(undefined)}
        onFinish={({ fields }) => {
          try {
            onApply(fields);
          } catch (failure) {
            setError(configurationErrorMessage(failure));
          }
        }}
      >
        <Form.List
          name="fields"
          rules={[
            {
              validator: async (_, fields: ProfileProbeField[]) => {
                if (fields.length > maximumTestProbeFieldCount)
                  throw new Error(`Declare at most ${maximumTestProbeFieldCount} fields.`);
                const ids = fields.map((field) => field.id);
                if (new Set(ids).size !== ids.length)
                  throw new Error("Use a unique field ID within this test command.");
              },
            },
          ]}
        >
          {(fields, { add, remove }, { errors }) => (
            <>
              {fields.map((field, index) => (
                <div className="validation-profiles-probe-field" key={field.key}>
                  <div className="validation-profiles-probe-heading">
                    <Typography.Text strong>Field {index + 1}</Typography.Text>
                    <Button
                      type="text"
                      onClick={() => remove(field.name)}
                      aria-label={`Remove field ${index + 1}`}
                    >
                      Remove
                    </Button>
                  </div>
                  <div className="validation-profiles-form-grid">
                    <Form.Item
                      name={[field.name, "id"]}
                      label="Field ID"
                      rules={[
                        { required: true, message: "Enter a field ID." },
                        { max: 128, message: "Use at most 128 characters." },
                        {
                          pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
                          message:
                            "Start with a letter or number; use letters, numbers, ., _, :, or -.",
                        },
                      ]}
                    >
                      <Input maxLength={128} placeholder="e.g. saved-title" />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, "type"]}
                      label="Value type"
                      rules={[{ required: true, message: "Choose a value type." }]}
                    >
                      <Select
                        options={[
                          { value: "boolean", label: "Boolean (true / false)" },
                          { value: "string", label: "String (text)" },
                          { value: "number", label: "Number" },
                        ]}
                      />
                    </Form.Item>
                  </div>
                  <Form.Item
                    name={[field.name, "description"]}
                    label="Description"
                    rules={[
                      {
                        required: true,
                        whitespace: true,
                        message: "Describe what this field reports.",
                      },
                      { max: 2_048, message: "Use at most 2,048 characters." },
                      {
                        validator: async (_, value: string) => {
                          if (value?.includes(String.fromCharCode(0)))
                            throw new Error("Remove the null character.");
                        },
                      },
                    ]}
                  >
                    <Input.TextArea
                      autoSize={{ minRows: 2, maxRows: 5 }}
                      maxLength={2_048}
                      placeholder="e.g. The title read after saving and reopening the document."
                    />
                  </Form.Item>
                </div>
              ))}
              {fields.length === 0 && (
                <Typography.Paragraph type="secondary">
                  No observable fields declared. Applying an empty list removes the declaration.
                </Typography.Paragraph>
              )}
              <Space wrap>
                <Button
                  onClick={() => add({ id: "", description: "", type: "boolean" })}
                  disabled={disabled || fields.length >= maximumTestProbeFieldCount}
                >
                  Add field
                </Button>
                <Typography.Text type="secondary">
                  {fields.length} / {maximumTestProbeFieldCount} fields
                </Typography.Text>
              </Space>
              <Form.ErrorList errors={errors} />
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
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
  const [form] = Form.useForm<ProfileFormValues>();
  const [baseline, setBaseline] = useState<ValidationProfileVersion | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [editingStep, setEditingStep] = useState<ValidationCommandStep>();
  const workflowKind =
    Form.useWatch("workflowKind", form) ?? baseline?.workflowKind ?? "pr_static_build";
  const target = Form.useWatch("target", form) ?? baseline?.target ?? "headless";
  const configJson = Form.useWatch("configJson", form) ?? profileFormValues(baseline).configJson;
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
      form.setFieldsValue(profileFormValues(latestQuery.data));
    }
  }, [baseline, form, latestQuery.data, latestQuery.isFetching, latestQuery.isError]);

  const reloadLatest = async () => {
    try {
      const result = await latestQuery.refetch({ throwOnError: true });
      if (!result.data) return;
      setBaseline(result.data);
      form.setFieldsValue(profileFormValues(result.data));
      setEditingStep(undefined);
      setError(null);
      setConflict(false);
    } catch (failure) {
      setError(configurationErrorMessage(failure));
    }
  };
  const publish = async (values: ProfileFormValues) => {
    if (!canConfigure || saving) return;
    if (conflict || (source && (!baseline || latestQuery.isFetching || latestQuery.isError)))
      return;
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
      setSaving(false);
    }
  };
  const ready = !source || baseline !== undefined;
  const updateConfig = (next: string) => {
    if (!canConfigure || saving || conflict) throw new Error("This draft cannot be edited now.");
    form.setFieldValue("configJson", next);
    void form.validateFields(["configJson"]).catch(() => undefined);
  };

  return (
    <Drawer
      open
      title={source ? `New version · ${source.name}` : "Create validation profile"}
      size={760}
      onClose={onClose}
      closable={!saving}
      mask={{ closable: !saving }}
      keyboard={!saving}
      footer={
        <div className="validation-profiles-actions">
          <Button disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="primary"
            loading={saving}
            disabled={
              !canConfigure ||
              !ready ||
              conflict ||
              latestQuery.isFetching ||
              (Boolean(source) && latestQuery.isError)
            }
            onClick={() => form.submit()}
          >
            {source ? "Publish new version" : "Publish profile"}
          </Button>
        </div>
      }
    >
      {!ready && (latestQuery.isPending || latestQuery.isFetching) && (
        <Skeleton active paragraph={{ rows: 10 }} />
      )}
      {!ready && latestQuery.isError && (
        <Alert
          type="error"
          showIcon
          title="Could not load the latest version"
          description={configurationErrorMessage(latestQuery.error)}
          action={<Button onClick={reloadLatest}>Try again</Button>}
        />
      )}
      {ready && (
        <>
          {!access.allows("configure") && (
            <Alert
              className="validation-profiles-notice"
              type="warning"
              showIcon
              title="Configuration permission required"
              description="Your draft is preserved. Repository configuration permission is required to publish this profile."
            />
          )}
          <Typography.Paragraph type="secondary">
            Published versions are read-only.{" "}
            {baseline
              ? `This creates version ${baseline.version + 1} from version ${baseline.version}. `
              : ""}
            Publishing saves configuration; it does not run tests or change the repository binding.
          </Typography.Paragraph>
          {latestQuery.isError && !conflict && (
            <Alert
              className="validation-profiles-notice"
              type="error"
              showIcon
              title="Could not refresh the latest version"
              description={
                <>
                  <p>{configurationErrorMessage(latestQuery.error)}</p>
                  <p>Your draft has been preserved. Retry the connection before publishing.</p>
                </>
              }
              action={
                <Button loading={latestQuery.isFetching} onClick={() => void latestQuery.refetch()}>
                  Retry connection
                </Button>
              }
            />
          )}
          {conflict ? (
            <Alert
              className="validation-profiles-notice"
              type="warning"
              showIcon
              title="A newer version was published"
              description={
                <>
                  <p>{error}</p>
                  <p>
                    Reload the latest version, then reapply your changes. Reloading replaces this
                    draft.
                  </p>
                </>
              }
              action={
                <Button loading={latestQuery.isFetching} onClick={reloadLatest}>
                  Reload latest version
                </Button>
              }
            />
          ) : error ? (
            <Alert
              className="validation-profiles-notice"
              type="error"
              showIcon
              title="Could not publish profile"
              description={error}
            />
          ) : null}
          <Form
            form={form}
            layout="vertical"
            initialValues={profileFormValues()}
            onFinish={publish}
            disabled={!canConfigure || saving || conflict}
            onValuesChange={(changed: Partial<ProfileFormValues>) => {
              if (changed.workflowKind && !source) {
                const supported = profileTargets(changed.workflowKind);
                if (!supported.includes(form.getFieldValue("target")))
                  form.setFieldValue("target", supported[0]);
                void form.validateFields(["configJson"]).catch(() => undefined);
              }
            }}
          >
            <Form.Item
              name="name"
              label="Profile name"
              rules={[
                { required: true, whitespace: true, message: "Enter a profile name." },
                { max: 128, message: "Use at most 128 characters." },
              ]}
            >
              <Input maxLength={128} placeholder="e.g. Windows build and unit tests" />
            </Form.Item>
            <div className="validation-profiles-form-grid">
              <Form.Item
                name="workflowKind"
                label="Workflow"
                rules={[{ required: true }]}
                extra={source ? "Fixed for every version of this profile." : undefined}
              >
                <Select
                  disabled={!canConfigure || Boolean(source) || saving || conflict}
                  options={Object.entries(workflowLabels).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
              </Form.Item>
              <Form.Item
                name="target"
                label="Execution target"
                rules={[{ required: true }]}
                extra={source ? "Fixed for every version of this profile." : undefined}
              >
                <Select
                  disabled={!canConfigure || Boolean(source) || saving || conflict}
                  options={profileTargets(workflowKind).map((value) => ({
                    value,
                    label: targetLabels[value],
                  }))}
                />
              </Form.Item>
            </div>
            <Descriptions
              size="small"
              column={1}
              className="validation-profiles-notice"
              items={[
                {
                  key: "schema",
                  label: "Output schema",
                  children: <code>{profileOutputSchemas[workflowKind]}</code>,
                },
              ]}
            />
            {workflowKind === "issue_triage" ? (
              <Alert
                className="validation-profiles-notice"
                type="info"
                showIcon
                title="Static triage only"
                description="Issue triage cannot execute commands. Keep setup, build, test, launch, and cleanup arrays empty."
              />
            ) : workflowKind === "pr_ui" || workflowKind === "issue_validation" ? (
              <Alert
                className="validation-profiles-notice"
                type="info"
                showIcon
                title="A matching validation driver is required"
                description="Workers need a configured driver for this workflow and execution target before they can execute this profile. Publishing this configuration does not mean validation has passed."
              />
            ) : null}
            <Form.Item
              name="required"
              label="Required profile"
              valuePropName="checked"
              extra="Include this profile as a required part of the workflow when its repository binding is enabled."
            >
              <Switch />
            </Form.Item>
            {workflowKind !== "issue_triage" && (
              <div className="validation-profiles-notice">
                <Typography.Title level={5}>Test observables</Typography.Title>
                <Typography.Paragraph type="secondary">
                  Declare values reported by test commands so Issue reproduction cases can compare
                  them with expected results. Each command can declare up to 32 boolean, string, or
                  number fields.
                </Typography.Paragraph>
                {!configDraft ? (
                  <Typography.Paragraph type="secondary">
                    Fix the execution configuration JSON below to edit test observables.
                  </Typography.Paragraph>
                ) : configDraft.test.length === 0 ? (
                  <Typography.Paragraph type="secondary">
                    Add a test command in the execution configuration to declare observable fields.
                  </Typography.Paragraph>
                ) : (
                  configDraft.test.map((step) => (
                    <div className="validation-profiles-probe-command" key={step.id}>
                      <div>
                        <Typography.Text strong>{step.name}</Typography.Text>
                        <div className="validation-profiles-secondary">
                          <code>{step.id}</code>
                        </div>
                        <Space wrap size={4}>
                          {step.probeOutput?.fields.map((field) => (
                            <Tag key={field.id}>
                              {field.id} · {field.type}
                            </Tag>
                          )) ?? (
                            <Typography.Text type="secondary">No fields declared</Typography.Text>
                          )}
                        </Space>
                      </div>
                      <Button onClick={() => setEditingStep(step)}>
                        {step.probeOutput ? "Edit fields" : "Add fields"}
                      </Button>
                    </div>
                  ))
                )}
              </div>
            )}
            {target === "web" && (
              <Form.Item
                label="Browser trace capture"
                extra="On failure keeps traces for failed scenarios; Always keeps every scenario trace. Off skips browser traces and keeps the configured screenshots. Issue reproduction requires Off."
              >
                <Select
                  aria-label="Browser trace capture"
                  value={
                    configDraft?.ui?.target === "web" ? configDraft.ui.evidence.trace : undefined
                  }
                  disabled={
                    !canConfigure || saving || conflict || configDraft?.ui?.target !== "web"
                  }
                  placeholder={
                    configDraft
                      ? "Add Web UI scenarios to choose trace capture"
                      : "Fix the configuration JSON to choose trace capture"
                  }
                  options={Object.entries(webTraceLabels).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                  onChange={(trace) => {
                    try {
                      updateConfig(
                        updateProfileWebTrace(
                          form.getFieldValue("configJson"),
                          workflowKind,
                          target,
                          trace,
                        ),
                      );
                    } catch (failure) {
                      setError(configurationErrorMessage(failure));
                    }
                  }}
                />
              </Form.Item>
            )}
            <Form.Item
              name="configJson"
              label="Execution configuration (JSON)"
              dependencies={["workflowKind", "target"]}
              rules={[
                {
                  validator: async (_: unknown, value: string) => {
                    parseProfileConfig(
                      value ?? "",
                      form.getFieldValue("workflowKind"),
                      form.getFieldValue("target"),
                    );
                  },
                },
              ]}
              extra="ValidationProfileV1 · All five stage arrays, capability names, and both timeouts are required."
            >
              <Input.TextArea
                className="validation-profiles-code"
                autoSize={{ minRows: 16, maxRows: 28 }}
                spellCheck={false}
                aria-label="Execution configuration JSON"
              />
            </Form.Item>
            <Collapse
              size="small"
              items={[
                {
                  key: "schema",
                  label: "Configuration schema and command example",
                  children: (
                    <>
                      <Typography.Paragraph>
                        Use setup, build, test, launch, and cleanup arrays with at most 32 steps per
                        stage. Each step needs a unique id, a name, a command, timeoutMs, and
                        required.
                      </Typography.Paragraph>
                      <Typography.Paragraph>
                        Commands use an executable and an args array. workingDirectory is a relative
                        workspace path such as "." and cannot escape the workspace. environment
                        entries use {"{ name, value }"} or {"{ name, secretRef }"}; credentials must
                        use secretRef.
                      </Typography.Paragraph>
                      <pre className="validation-profiles-json">
                        {JSON.stringify(stepExample, null, 2)}
                      </pre>
                      <Typography.Paragraph>
                        hardTimeoutMs, noProgressTimeoutMs, and each step timeoutMs must be whole
                        milliseconds between 1,000 and 86,400,000. Neither the no-progress timeout
                        nor a step timeout may exceed the hard timeout. requiredCapabilities is an
                        array of unique capability names. Configuration is limited to 262,144 UTF-8
                        bytes.
                      </Typography.Paragraph>
                      <Typography.Paragraph>
                        Test commands can declare optional probeOutput fields with a unique id,
                        description, and type (boolean, string, or number). Use the test observables
                        editor above to add or remove these declarations. Other command stages
                        cannot declare probe output.
                      </Typography.Paragraph>
                      <Typography.Paragraph>
                        UI workflows can add an "ui" object with schemaVersion "UiScenariosV1". Its
                        target must match this profile. Reference a persistent launch step, define
                        readiness and reset behavior, and add named scenarios with required
                        assertions. Web scenarios use managed loopback navigation and exact role or
                        test ID locators; Windows scenarios stay inside the launched process tree.
                        Configure evidence capture explicitly. Legacy profiles without scenarios
                        remain readable but cannot establish UI execution readiness.
                      </Typography.Paragraph>
                    </>
                  ),
                },
              ]}
            />
          </Form>
          {editingStep && (
            <ProbeFieldsEditor
              step={editingStep}
              disabled={!canConfigure || saving || conflict}
              onClose={() => setEditingStep(undefined)}
              onApply={(fields) => {
                updateConfig(
                  updateProfileProbeFields(
                    form.getFieldValue("configJson"),
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
    </Drawer>
  );
}
