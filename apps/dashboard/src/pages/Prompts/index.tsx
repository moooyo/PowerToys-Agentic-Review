import {
  type PromptTemplate,
  type PromptTemplateSummary,
  type WorkflowKind,
  WorkflowOutputSchemaVersions,
} from "@agentic-review/contracts";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import { GlobalPromptActivity } from "@/components/ConfigurationAudit";
import { configurationAuditQueryRoot } from "@/components/ConfigurationAudit/state";
import { ConfigurationScopeGuard } from "@/components/ConfigurationScopeGuard";
import { OperatorAccessGate } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import { RepositoryScopeUnavailable, useRepositoryScope } from "@/components/RepositoryScope";
import { configuration } from "@/services/configuration";
import { usePromptAvailable } from "./access";
import {
  buildPromptCreate,
  type CreatePromptValues,
  configurationErrorMessage,
  validatePromptContent,
  validatePromptName,
  workflowLabels,
  workflowOptions,
} from "./forms";
import { PromptBindings } from "./PromptBindings";
import { PromptEditor } from "./PromptEditor";
import { promptQueryKeys } from "./queries";
import "./index.css";

function CreatePromptDrawer({
  onClose,
  onCreated,
  initialWorkflowKind,
}: {
  onClose: () => void;
  onCreated: (template: PromptTemplate) => void;
  initialWorkflowKind: WorkflowKind;
}) {
  const available = usePromptAvailable();
  const [form] = Form.useForm<CreatePromptValues>();
  const workflowKind: WorkflowKind = Form.useWatch("workflowKind", form) ?? initialWorkflowKind;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async (values: CreatePromptValues) => {
    if (!available || saving) return;
    setSaving(true);
    setError(null);
    try {
      onCreated(await configuration.createPrompt(buildPromptCreate(values)));
    } catch (failure) {
      setError(configurationErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer
      open
      title="Create prompt template"
      size={760}
      closable={!saving}
      mask={{ closable: !saving }}
      keyboard={!saving}
      onClose={onClose}
      footer={
        <div className="prompts-drawer-actions">
          <Button disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="primary"
            loading={saving}
            disabled={!available}
            onClick={() => form.submit()}
          >
            Create template
          </Button>
        </div>
      }
    >
      <Typography.Paragraph type="secondary">
        Create a shared template with an editable draft. Publishing and workflow binding are
        separate steps.
      </Typography.Paragraph>
      {error && (
        <Alert
          className="prompts-notice"
          showIcon
          type="error"
          title="Could not create template"
          description={error}
        />
      )}
      <Form
        form={form}
        layout="vertical"
        disabled={!available || saving}
        initialValues={{
          name: "",
          description: "",
          workflowKind: initialWorkflowKind,
          content: "",
        }}
        onFinish={create}
      >
        <Form.Item
          label="Template name"
          name="name"
          rules={[
            { required: true, whitespace: true, message: "Enter a template name." },
            { max: 128, message: "Use at most 128 characters." },
            {
              validator: async (_: unknown, value: string | undefined) =>
                validatePromptName(value ?? ""),
            },
          ]}
        >
          <Input maxLength={128} placeholder="e.g. Maintainer code review" />
        </Form.Item>
        <Form.Item
          label="Description"
          name="description"
          rules={[
            { max: 2_048, message: "Use at most 2,048 characters." },
            {
              validator: async (_: unknown, value: string | undefined) => {
                if (value?.includes("\u0000")) throw new Error("Remove null characters.");
              },
            },
          ]}
        >
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 4 }}
            maxLength={2_048}
            placeholder="What should this template help reviewers do?"
          />
        </Form.Item>
        <div className="prompts-form-columns">
          <Form.Item
            label="Workflow"
            name="workflowKind"
            rules={[{ required: true }]}
            extra="A template's workflow cannot be changed after creation."
          >
            <Select options={workflowOptions} />
          </Form.Item>
          <Form.Item label="Output schema" extra="Determined by the workflow.">
            <Input
              readOnly
              value={WorkflowOutputSchemaVersions[workflowKind]}
              aria-label="Output schema determined by workflow"
            />
          </Form.Item>
        </div>
        {(workflowKind === "pr_ui" || workflowKind === "issue_validation") && (
          <Alert
            className="prompts-notice"
            showIcon
            type="info"
            title="Validation also requires a configured driver"
            description="Publishing this prompt will not enable validation or start a job. Configure the workflow's validation profile and driver separately."
          />
        )}
        <Form.Item
          label="Prompt content"
          name="content"
          rules={[
            {
              validator: async (_: unknown, value: string | undefined) =>
                validatePromptContent(value ?? ""),
            },
          ]}
          required
          extra="Content is preserved exactly as entered. Maximum size: 262,144 UTF-8 bytes."
        >
          <Input.TextArea
            className="prompts-code-editor"
            autoSize={{ minRows: 14, maxRows: 26 }}
            spellCheck={false}
            placeholder="Write the instructions for this workflow…"
          />
        </Form.Item>
      </Form>
    </Drawer>
  );
}

function PromptWorkspace({
  repositoryId,
  scopeLabel,
}: {
  repositoryId: string | null;
  scopeLabel: string;
}) {
  const available = usePromptAvailable();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [workflowKind, setWorkflowKind] = useState<WorkflowKind | undefined>();
  const [creating, setCreating] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const listQuery = useQuery({
    queryKey: promptQueryKeys.templateList(page, pageSize, workflowKind),
    queryFn: () =>
      configuration.listPrompts({ page, pageSize, ...(workflowKind ? { workflowKind } : {}) }),
    enabled: available,
  });
  const refresh = async () => {
    if (!available) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: promptQueryKeys.templates }),
      queryClient.invalidateQueries({ queryKey: promptQueryKeys.bindings }),
      queryClient.invalidateQueries({ queryKey: promptQueryKeys.bindingHistories }),
      queryClient.invalidateQueries({ queryKey: configurationAuditQueryRoot }),
    ]);
  };
  return (
    <>
      <PageHeader
        eyebrow="Configuration"
        title="Prompts"
        titleId="prompts-page-title"
        description="Write workflow instructions, publish versions, and choose which version each workflow uses."
        actions={
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              loading={listQuery.isFetching}
              disabled={!available}
              onClick={refresh}
            >
              Refresh
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!available}
              onClick={() => setCreating(true)}
            >
              Create template
            </Button>
          </Space>
        }
      />
      {process.env.NODE_ENV === "development" && (
        <Alert
          className="prompts-notice"
          type="info"
          showIcon
          title="Sample data"
          description="This preview uses sample templates and bindings. Changes affect the preview only."
        />
      )}
      <Card>
        <Tabs
          items={[
            {
              key: "templates",
              label: "Templates",
              disabled: !available,
              children: (
                <>
                  <div className="prompts-toolbar">
                    <Typography.Paragraph type="secondary">
                      Templates are shared across repositories. Workflow bindings select the
                      versions used by each repository.
                    </Typography.Paragraph>
                    <Select
                      aria-label="Filter templates by workflow"
                      className="prompts-workflow-filter"
                      allowClear
                      placeholder="All workflows"
                      options={workflowOptions}
                      value={workflowKind}
                      disabled={!available}
                      onChange={(value: WorkflowKind | undefined) => {
                        setWorkflowKind(value);
                        setPage(1);
                      }}
                    />
                  </div>
                  {listQuery.isError ? (
                    <Alert
                      type="error"
                      showIcon
                      title="Could not load templates"
                      description={configurationErrorMessage(listQuery.error)}
                      action={
                        <Button
                          disabled={!available}
                          onClick={() => {
                            if (available) void listQuery.refetch();
                          }}
                        >
                          Try again
                        </Button>
                      }
                    />
                  ) : (
                    <Table<PromptTemplateSummary>
                      rowKey="id"
                      loading={listQuery.isFetching}
                      dataSource={listQuery.data?.items ?? []}
                      columns={[
                        {
                          title: "Template",
                          dataIndex: "name",
                          render: (name: string, template) => (
                            <div className="prompts-template-cell">
                              <Button
                                type="link"
                                className="prompts-name-link"
                                disabled={!available}
                                onClick={() => setSelectedTemplateId(template.id)}
                              >
                                {name}
                              </Button>
                              {template.description && (
                                <span className="prompts-secondary prompts-break">
                                  {template.description}
                                </span>
                              )}
                            </div>
                          ),
                        },
                        {
                          title: "Workflow",
                          dataIndex: "workflowKind",
                          width: 230,
                          render: (value: WorkflowKind) => workflowLabels[value],
                        },
                        {
                          title: "Publication",
                          key: "publication",
                          width: 150,
                          render: (_: unknown, template) => (
                            <div className="prompts-template-cell">
                              <Tag color={template.latestPublishedVersionId ? "blue" : "default"}>
                                {template.latestPublishedVersionId
                                  ? "Published version available"
                                  : "Draft only"}
                              </Tag>
                              <span className="prompts-secondary">
                                Draft revision {template.draftRevision}
                              </span>
                            </div>
                          ),
                        },
                        {
                          title: "Updated",
                          dataIndex: "updatedAt",
                          width: 170,
                          render: (value: string) => (
                            <time dateTime={value}>{new Date(value).toLocaleString("en-US")}</time>
                          ),
                        },
                        {
                          title: "",
                          key: "edit",
                          width: 105,
                          render: (_: unknown, template) => (
                            <Button
                              disabled={!available}
                              onClick={() => setSelectedTemplateId(template.id)}
                              aria-label={`Edit ${template.name}`}
                            >
                              Open
                            </Button>
                          ),
                        },
                      ]}
                      scroll={{ x: 900 }}
                      locale={{
                        emptyText: (
                          <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description={
                              workflowKind
                                ? "No templates for this workflow."
                                : "Create a template to define your review instructions."
                            }
                          >
                            <Button
                              type="primary"
                              disabled={!available}
                              onClick={() => setCreating(true)}
                            >
                              Create template
                            </Button>
                          </Empty>
                        ),
                      }}
                      pagination={{
                        current: page,
                        pageSize,
                        total: listQuery.data?.total ?? 0,
                        hideOnSinglePage: true,
                        showSizeChanger: true,
                        pageSizeOptions: [20, 50],
                        disabled: !available,
                        onChange: (nextPage, nextSize) => {
                          setPage(nextSize === pageSize ? nextPage : 1);
                          setPageSize(nextSize);
                        },
                        showTotal: (count, range) => `${range[0]}–${range[1]} of ${count}`,
                      }}
                    />
                  )}
                </>
              ),
            },
            {
              key: "bindings",
              label: "Workflow bindings",
              disabled: !available,
              children: (
                <PromptBindings
                  key={repositoryId ?? "global"}
                  repositoryId={repositoryId}
                  scopeLabel={scopeLabel}
                />
              ),
            },
            {
              key: "activity",
              label: "Global prompt activity",
              disabled: !available,
              children: <GlobalPromptActivity enabled={available} />,
            },
          ]}
        />
      </Card>
      {creating && (
        <CreatePromptDrawer
          initialWorkflowKind={workflowKind ?? "pr_static_build"}
          onClose={() => setCreating(false)}
          onCreated={(template) => {
            setCreating(false);
            setSelectedTemplateId(template.id);
            queryClient.setQueryData(promptQueryKeys.template(template.id), template);
            void queryClient.invalidateQueries({ queryKey: promptQueryKeys.templates });
            void queryClient.invalidateQueries({ queryKey: configurationAuditQueryRoot });
          }}
        />
      )}
      {selectedTemplateId && (
        <PromptEditor
          key={`${repositoryId ?? "global"}:${selectedTemplateId}`}
          templateId={selectedTemplateId}
          repositoryId={repositoryId}
          onClose={() => setSelectedTemplateId(null)}
        />
      )}
    </>
  );
}

export default function PromptsPage() {
  const scope = useRepositoryScope();
  return (
    <OperatorAccessGate platformOnly>
      <section className="prompts-page" aria-labelledby="prompts-page-title">
        <ConfigurationScopeGuard
          key={scope.key}
          scopeKey={scope.key}
          available={scope.ready && !scope.error}
          fallback={
            <>
              <PageHeader
                eyebrow="Configuration"
                title="Prompts"
                titleId="prompts-page-title"
                description="Load a valid repository scope to manage prompt templates and bindings."
              />
              <RepositoryScopeUnavailable />
            </>
          }
        >
          <PromptWorkspace
            key={scope.key}
            repositoryId={scope.repositoryId ?? null}
            scopeLabel={scope.repositoryId ? scope.label : "Global defaults"}
          />
        </ConfigurationScopeGuard>
      </section>
    </OperatorAccessGate>
  );
}
