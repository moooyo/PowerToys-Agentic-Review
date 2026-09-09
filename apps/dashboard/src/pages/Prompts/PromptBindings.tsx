import {
  type PromptBinding,
  type PromptTemplateSummary,
  type PromptVersionSummary,
  type WorkflowKind,
  WorkflowKindValues,
} from "@agentic-review/contracts";
import { HistoryOutlined, ReloadOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Input,
  message,
  Pagination,
  Skeleton,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import { configuration } from "@/services/configuration";
import type { ConfigurationPage, PromptBindingHistory } from "@/services/configuration/adapter";
import { usePromptAvailable } from "./access";
import {
  bindingExpectedVersion,
  configurationErrorMessage,
  isPromptConflict,
  workflowLabels,
} from "./forms";
import { promptQueryKeys } from "./queries";
import "./bindings.css";

function Timestamp({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
}

function VersionId({ value }: { value: string }) {
  return (
    <Typography.Text className="prompt-bindings-code" copyable={{ text: value }}>
      {value}
    </Typography.Text>
  );
}

function BindingPagination({
  result,
  loading,
  onChange,
}: {
  result: ConfigurationPage<unknown>;
  loading: boolean;
  onChange: (page: number, pageSize: number) => void;
}) {
  if (result.total === 0) return null;
  return (
    <div className="prompt-bindings-pagination">
      <Pagination
        current={result.page}
        pageSize={result.pageSize}
        total={result.total}
        showSizeChanger
        pageSizeOptions={[20, 50]}
        disabled={loading}
        onChange={(page, pageSize) => onChange(pageSize === result.pageSize ? page : 1, pageSize)}
        showTotal={(total, range) => `${range[0]}–${range[1]} of ${total}`}
      />
    </div>
  );
}

function PublishedVersionDrawer({
  template,
  version,
  onClose,
}: {
  template: PromptTemplateSummary;
  version: PromptVersionSummary;
  onClose: () => void;
}) {
  const available = usePromptAvailable();
  const versionQuery = useQuery({
    queryKey: promptQueryKeys.version(template.id, version.id),
    queryFn: () => configuration.getPromptVersion(template.id, version.id),
    enabled: available,
    refetchOnWindowFocus: false,
  });

  return (
    <Drawer
      open
      title={`Published version ${version.version} · ${template.name}`}
      size={760}
      mask={{ closable: true }}
      onClose={onClose}
    >
      {versionQuery.isPending && <Skeleton active paragraph={{ rows: 10 }} />}
      {versionQuery.isError && (
        <Alert
          showIcon
          type="error"
          title="Could not load published version"
          description={configurationErrorMessage(versionQuery.error)}
          action={
            <Button
              disabled={!available}
              onClick={() => {
                if (available) void versionQuery.refetch();
              }}
            >
              Try again
            </Button>
          }
        />
      )}
      {versionQuery.isSuccess && (
        <>
          <Typography.Paragraph type="secondary">
            Published content is immutable. This is a read-only view.
          </Typography.Paragraph>
          <Descriptions
            className="prompt-bindings-facts"
            column={1}
            size="small"
            items={[
              {
                key: "id",
                label: "Version ID",
                children: <VersionId value={versionQuery.data.id} />,
              },
              {
                key: "schema",
                label: "Output schema",
                children: versionQuery.data.outputSchemaVersion,
              },
              {
                key: "published",
                label: "Published",
                children: <Timestamp value={versionQuery.data.publishedAt} />,
              },
              {
                key: "actor",
                label: "Published by",
                children: (
                  <span className="prompt-bindings-wrap">{versionQuery.data.createdBy}</span>
                ),
              },
              {
                key: "hash",
                label: "SHA-256",
                children: <VersionId value={versionQuery.data.contentSha256} />,
              },
            ]}
          />
          <Input.TextArea
            className="prompt-bindings-content"
            aria-label="Published prompt content"
            readOnly
            autoSize={{ minRows: 14, maxRows: 30 }}
            value={versionQuery.data.content}
          />
        </>
      )}
    </Drawer>
  );
}

function BindingEditor({
  repositoryId,
  scopeLabel,
  workflowKind,
  initialBinding,
  onClose,
  onSaved,
}: {
  repositoryId: string | null;
  scopeLabel: string;
  workflowKind: WorkflowKind;
  initialBinding: PromptBinding | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const available = usePromptAvailable();
  const queryClient = useQueryClient();
  const [baseline, setBaseline] = useState(initialBinding);
  const [expectedVersion, setExpectedVersion] = useState(() =>
    bindingExpectedVersion(initialBinding, repositoryId, workflowKind),
  );
  const [templatePage, setTemplatePage] = useState(1);
  const [templatePageSize, setTemplatePageSize] = useState(20);
  const [versionPage, setVersionPage] = useState(1);
  const [versionPageSize, setVersionPageSize] = useState(20);
  const [selectedTemplate, setSelectedTemplate] = useState<PromptTemplateSummary | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<PromptVersionSummary | null>(null);
  const [viewingVersion, setViewingVersion] = useState<PromptVersionSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [reloaded, setReloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const templatesQuery = useQuery({
    queryKey: promptQueryKeys.templatePicker(workflowKind, templatePage, templatePageSize),
    queryFn: () =>
      configuration.listPrompts({ workflowKind, page: templatePage, pageSize: templatePageSize }),
    enabled: available && selectedTemplate === null,
    refetchOnWindowFocus: false,
  });
  const versionsQuery = useQuery({
    queryKey: promptQueryKeys.versionList(
      selectedTemplate?.id ?? null,
      versionPage,
      versionPageSize,
    ),
    queryFn: () => {
      if (!selectedTemplate)
        throw new Error("Choose a template before loading published versions.");
      return configuration.listPromptVersions(selectedTemplate.id, {
        page: versionPage,
        pageSize: versionPageSize,
      });
    },
    enabled: available && selectedTemplate !== null,
    refetchOnWindowFocus: false,
  });

  const reloadLatest = async () => {
    if (!available || saving || reloading) return;
    setReloading(true);
    setError(null);
    try {
      const result = await configuration.listPromptBindings(repositoryId);
      const latest = result.items.find(
        (binding) => binding.repositoryId === repositoryId && binding.workflowKind === workflowKind,
      );
      const nextExpectedVersion = bindingExpectedVersion(latest, repositoryId, workflowKind);
      queryClient.setQueryData(promptQueryKeys.bindingScope(repositoryId), result);
      setBaseline(latest);
      setExpectedVersion(nextExpectedVersion);
      setSelectedTemplate(null);
      setSelectedVersion(null);
      setViewingVersion(null);
      setTemplatePage(1);
      setVersionPage(1);
      setConflict(false);
      setReloaded(true);
    } catch (failure) {
      setError(configurationErrorMessage(failure));
    } finally {
      setReloading(false);
    }
  };

  const save = async () => {
    if (!available || !selectedTemplate || !selectedVersion || conflict || saving || reloading)
      return;
    if (selectedVersion.id === baseline?.promptVersionId) return;
    if (
      selectedVersion.templateId !== selectedTemplate.id ||
      selectedTemplate.workflowKind !== workflowKind
    ) {
      setError("Select a published version from a template for this workflow.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await configuration.savePromptBinding(repositoryId, workflowKind, {
        expectedVersion,
        promptVersionId: selectedVersion.id,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: promptQueryKeys.bindings }),
        queryClient.invalidateQueries({ queryKey: promptQueryKeys.bindingHistories }),
      ]);
      onSaved();
    } catch (failure) {
      setConflict(isPromptConflict(failure));
      setError(configurationErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  const selectionDisabled = !available || saving || reloading || conflict;
  const unchanged = selectedVersion?.id === baseline?.promptVersionId && selectedVersion !== null;

  return (
    <Drawer
      open
      title={`Bind prompt · ${workflowLabels[workflowKind]}`}
      size={900}
      onClose={onClose}
      closable={!saving && !reloading}
      mask={{ closable: !saving && !reloading }}
      keyboard={!saving && !reloading}
      footer={
        <div className="prompt-bindings-drawer-actions">
          <Button disabled={saving || reloading} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="primary"
            loading={saving}
            disabled={!selectedVersion || selectionDisabled || unchanged}
            onClick={() => void save()}
          >
            {repositoryId !== null && !baseline ? "Create repository override" : "Save binding"}
          </Button>
        </div>
      }
    >
      <Descriptions
        className="prompt-bindings-facts"
        size="small"
        column={1}
        items={[
          { key: "scope", label: "Binding scope", children: scopeLabel },
          {
            key: "current",
            label: repositoryId === null ? "Current global binding" : "Current repository binding",
            children: baseline ? (
              <VersionId value={baseline.promptVersionId} />
            ) : (
              "Not bound in this scope"
            ),
          },
          ...(baseline
            ? [{ key: "revision", label: "Binding revision", children: baseline.version }]
            : []),
        ]}
      />
      {repositoryId === null && (
        <Alert
          className="prompt-bindings-notice"
          type="info"
          showIcon
          title="This changes the global default"
          description="Every repository without an override for this workflow uses this binding."
        />
      )}
      {conflict ? (
        <Alert
          className="prompt-bindings-notice"
          type="warning"
          showIcon
          title="This binding changed while you were choosing a version"
          description={
            <>
              {error && <p>{error}</p>}
              <p>
                Your selection has not been saved. Reload the latest binding, then choose a template
                and published version again.
              </p>
            </>
          }
          action={
            <Button disabled={!available} loading={reloading} onClick={() => void reloadLatest()}>
              Reload latest binding
            </Button>
          }
        />
      ) : error ? (
        <Alert
          className="prompt-bindings-notice"
          type="error"
          showIcon
          title="Could not save binding"
          description={error}
        />
      ) : reloaded ? (
        <Alert
          className="prompt-bindings-notice"
          type="info"
          showIcon
          title="Latest binding loaded"
          description="The previous selection was cleared. Choose a published version again to continue."
        />
      ) : null}

      {!selectedTemplate ? (
        <>
          <Typography.Title level={5}>1. Choose a template</Typography.Title>
          <Typography.Paragraph type="secondary">
            Templates for {workflowLabels[workflowKind].toLowerCase()}. Only templates with
            published versions can be bound.
          </Typography.Paragraph>
          {templatesQuery.isError ? (
            <Alert
              type="error"
              showIcon
              title="Could not load templates"
              description={configurationErrorMessage(templatesQuery.error)}
              action={
                <Button
                  disabled={!available}
                  onClick={() => {
                    if (available) void templatesQuery.refetch();
                  }}
                >
                  Try again
                </Button>
              }
            />
          ) : (
            <Table<PromptTemplateSummary>
              rowKey="id"
              size="small"
              pagination={false}
              loading={templatesQuery.isFetching}
              dataSource={templatesQuery.data?.items ?? []}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="No templates for this workflow"
                  />
                ),
              }}
              columns={[
                {
                  title: "Template",
                  key: "template",
                  render: (_, template) => (
                    <div className="prompt-bindings-template">
                      <Typography.Text strong>{template.name}</Typography.Text>
                      {template.description && (
                        <span className="prompt-bindings-secondary">{template.description}</span>
                      )}
                      <code className="prompt-bindings-secondary">{template.id}</code>
                    </div>
                  ),
                },
                {
                  title: "Publication",
                  key: "published",
                  width: 160,
                  render: (_, template) => (
                    <Tag color={template.latestPublishedVersionId ? "success" : "default"}>
                      {template.latestPublishedVersionId ? "Published versions" : "Draft only"}
                    </Tag>
                  ),
                },
                {
                  title: "Action",
                  key: "action",
                  width: 140,
                  render: (_, template) => (
                    <Button
                      disabled={selectionDisabled || !template.latestPublishedVersionId}
                      onClick={() => {
                        setSelectedTemplate(template);
                        setSelectedVersion(null);
                        setVersionPage(1);
                        setReloaded(false);
                        setError(null);
                      }}
                      aria-label={`Choose template ${template.name}`}
                    >
                      Choose template
                    </Button>
                  ),
                },
              ]}
              scroll={{ x: 560 }}
            />
          )}
          {templatesQuery.isSuccess && (
            <BindingPagination
              result={templatesQuery.data}
              loading={templatesQuery.isFetching || selectionDisabled}
              onChange={(page, pageSize) => {
                setTemplatePage(page);
                setTemplatePageSize(pageSize);
              }}
            />
          )}
        </>
      ) : (
        <>
          <div className="prompt-bindings-selection">
            <div className="prompt-bindings-template">
              <span className="prompt-bindings-secondary">Selected template</span>
              <Typography.Text strong>{selectedTemplate.name}</Typography.Text>
              <code className="prompt-bindings-secondary">{selectedTemplate.id}</code>
            </div>
            <Button
              disabled={selectionDisabled}
              onClick={() => {
                setSelectedTemplate(null);
                setSelectedVersion(null);
                setViewingVersion(null);
                setError(null);
              }}
            >
              Change template
            </Button>
          </div>
          <Typography.Title level={5}>2. Choose a published version</Typography.Title>
          <Typography.Paragraph type="secondary">
            You can select any published version, including an earlier version for a rollback.
          </Typography.Paragraph>
          {versionsQuery.isError ? (
            <Alert
              type="error"
              showIcon
              title="Could not load published versions"
              description={configurationErrorMessage(versionsQuery.error)}
              action={
                <Button
                  disabled={!available}
                  onClick={() => {
                    if (available) void versionsQuery.refetch();
                  }}
                >
                  Try again
                </Button>
              }
            />
          ) : (
            <Table<PromptVersionSummary>
              rowKey="id"
              size="small"
              pagination={false}
              loading={versionsQuery.isFetching}
              dataSource={versionsQuery.data?.items ?? []}
              rowClassName={(version) =>
                version.id === selectedVersion?.id ? "prompt-bindings-selected-row" : ""
              }
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="This template has no published versions"
                  />
                ),
              }}
              columns={[
                {
                  title: "Version",
                  key: "version",
                  render: (_, version) => (
                    <div className="prompt-bindings-template">
                      <Space wrap>
                        <Typography.Text strong>Version {version.version}</Typography.Text>
                        {version.id === selectedTemplate.latestPublishedVersionId && (
                          <Tag color="blue">Latest</Tag>
                        )}
                        {version.id === baseline?.promptVersionId && <Tag>Current binding</Tag>}
                      </Space>
                      <VersionId value={version.id} />
                    </div>
                  ),
                },
                {
                  title: "Published",
                  key: "published",
                  width: 180,
                  render: (_, version) => <Timestamp value={version.publishedAt} />,
                },
                {
                  title: "Actions",
                  key: "actions",
                  width: 220,
                  render: (_, version) => (
                    <Space wrap>
                      <Button
                        disabled={!available || saving || reloading}
                        onClick={() => setViewingVersion(version)}
                      >
                        View content
                      </Button>
                      <Button
                        type={version.id === selectedVersion?.id ? "primary" : "default"}
                        disabled={selectionDisabled}
                        aria-pressed={version.id === selectedVersion?.id}
                        aria-label={`Select published version ${version.version}`}
                        onClick={() => {
                          setSelectedVersion(version);
                          setError(null);
                        }}
                      >
                        {version.id === selectedVersion?.id ? "Selected" : "Select"}
                      </Button>
                    </Space>
                  ),
                },
              ]}
              scroll={{ x: 620 }}
            />
          )}
          {versionsQuery.isSuccess && (
            <BindingPagination
              result={versionsQuery.data}
              loading={versionsQuery.isFetching || selectionDisabled}
              onChange={(page, pageSize) => {
                setVersionPage(page);
                setVersionPageSize(pageSize);
              }}
            />
          )}
          {selectedVersion && (
            <div className="prompt-bindings-chosen" aria-live="polite">
              <Typography.Text strong>
                Selected: {selectedTemplate.name} · Version {selectedVersion.version}
              </Typography.Text>
              <VersionId value={selectedVersion.id} />
              {unchanged && (
                <span className="prompt-bindings-secondary">
                  This version is already bound in this scope. Select a different version to make a
                  change.
                </span>
              )}
            </div>
          )}
        </>
      )}
      {selectedTemplate && viewingVersion && (
        <PublishedVersionDrawer
          key={viewingVersion.id}
          template={selectedTemplate}
          version={viewingVersion}
          onClose={() => setViewingVersion(null)}
        />
      )}
    </Drawer>
  );
}

function BindingHistoryDrawer({
  repositoryId,
  scopeLabel,
  workflowKind,
  onClose,
}: {
  repositoryId: string | null;
  scopeLabel: string;
  workflowKind: WorkflowKind;
  onClose: () => void;
}) {
  const available = usePromptAvailable();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const historyQuery = useQuery({
    queryKey: promptQueryKeys.bindingHistory(repositoryId, workflowKind, page, pageSize),
    queryFn: () =>
      configuration.listPromptBindingHistory(repositoryId, workflowKind, { page, pageSize }),
    enabled: available,
    refetchOnWindowFocus: false,
  });

  return (
    <Drawer
      open
      title={`Binding history · ${workflowLabels[workflowKind]}`}
      size={1120}
      mask={{ closable: true }}
      onClose={onClose}
    >
      <Typography.Paragraph>
        <Typography.Text strong>Scope: </Typography.Text>
        {scopeLabel}
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary">
        This read-only history records changes to this scope's binding.
        {repositoryId !== null &&
          " Changes to an inherited global default appear in the global binding history."}
      </Typography.Paragraph>
      {historyQuery.isError ? (
        <Alert
          showIcon
          type="error"
          title="Could not load binding history"
          description={configurationErrorMessage(historyQuery.error)}
          action={
            <Button
              disabled={!available}
              onClick={() => {
                if (available) void historyQuery.refetch();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : (
        <Table<PromptBindingHistory>
          rowKey="id"
          size="small"
          pagination={false}
          loading={!available || historyQuery.isFetching}
          dataSource={historyQuery.data?.items ?? []}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No binding changes recorded for this scope"
              />
            ),
          }}
          columns={[
            { title: "Binding revision", dataIndex: "version", width: 110 },
            {
              title: "Previous version ID",
              key: "previous",
              width: 210,
              render: (_, entry) =>
                entry.previousVersionId ? (
                  <VersionId value={entry.previousVersionId} />
                ) : (
                  <span className="prompt-bindings-secondary">No previous binding</span>
                ),
            },
            {
              title: "New version ID",
              key: "next",
              width: 210,
              render: (_, entry) => <VersionId value={entry.promptVersionId} />,
            },
            {
              title: "Changed by",
              key: "actor",
              width: 230,
              render: (_, entry) => <span className="prompt-bindings-wrap">{entry.createdBy}</span>,
            },
            {
              title: "Changed at",
              key: "time",
              width: 180,
              render: (_, entry) => <Timestamp value={entry.createdAt} />,
            },
          ]}
          scroll={{ x: 940 }}
        />
      )}
      {historyQuery.isSuccess && (
        <BindingPagination
          result={historyQuery.data}
          loading={!available || historyQuery.isFetching}
          onChange={(nextPage, nextSize) => {
            setPage(nextPage);
            setPageSize(nextSize);
          }}
        />
      )}
    </Drawer>
  );
}

function BindingsScope({
  repositoryId,
  scopeLabel,
}: {
  repositoryId: string | null;
  scopeLabel: string;
}) {
  const available = usePromptAvailable();
  const [messageApi, contextHolder] = message.useMessage();
  const [editing, setEditing] = useState<{
    workflowKind: WorkflowKind;
    binding: PromptBinding | undefined;
  } | null>(null);
  const [historyWorkflow, setHistoryWorkflow] = useState<WorkflowKind | null>(null);
  const bindingsQuery = useQuery({
    queryKey: promptQueryKeys.bindingScope(repositoryId),
    queryFn: () => configuration.listPromptBindings(repositoryId),
    enabled: available,
    refetchOnWindowFocus: false,
  });
  const globalQuery = useQuery({
    queryKey: promptQueryKeys.bindingScope(null),
    queryFn: () => configuration.listPromptBindings(null),
    enabled: available && repositoryId !== null,
    refetchOnWindowFocus: false,
  });

  return (
    <section className="prompt-bindings" aria-label={`Prompt bindings for ${scopeLabel}`}>
      {contextHolder}
      <div className="prompt-bindings-toolbar">
        <div>
          <Typography.Title level={4}>
            {repositoryId === null ? "Global workflow defaults" : "Repository workflow overrides"}
          </Typography.Title>
          <Typography.Paragraph type="secondary">
            {repositoryId === null
              ? "Global defaults apply to every repository without an override for the workflow."
              : `Bindings for ${scopeLabel}. A repository override takes precedence over its global default.`}
          </Typography.Paragraph>
        </div>
        <Button
          icon={<ReloadOutlined />}
          loading={bindingsQuery.isFetching || (repositoryId !== null && globalQuery.isFetching)}
          disabled={!available}
          onClick={() => {
            if (!available) return;
            void bindingsQuery.refetch();
            if (repositoryId !== null) void globalQuery.refetch();
          }}
        >
          Refresh bindings
        </Button>
      </div>
      {bindingsQuery.isPending && <Skeleton active paragraph={{ rows: 8 }} />}
      {bindingsQuery.isError && (
        <Alert
          className="prompt-bindings-notice"
          type="error"
          showIcon
          title="Could not load bindings for this scope"
          description={configurationErrorMessage(bindingsQuery.error)}
          action={
            <Button
              disabled={!available}
              onClick={() => {
                if (available) void bindingsQuery.refetch();
              }}
            >
              Try again
            </Button>
          }
        />
      )}
      {repositoryId !== null && globalQuery.isError && (
        <Alert
          className="prompt-bindings-notice"
          type="warning"
          showIcon
          title="Global defaults are unavailable"
          description="Repository bindings are shown below. Inheritance cannot be determined until global defaults load."
          action={
            <Button
              disabled={!available}
              onClick={() => {
                if (available) void globalQuery.refetch();
              }}
            >
              Retry global defaults
            </Button>
          }
        />
      )}
      {bindingsQuery.isSuccess && (
        <ul className="prompt-bindings-list">
          {WorkflowKindValues.map((workflowKind) => {
            const ownBinding = bindingsQuery.data.items.find(
              (binding) =>
                binding.repositoryId === repositoryId && binding.workflowKind === workflowKind,
            );
            const globalBinding =
              repositoryId === null
                ? ownBinding
                : globalQuery.data?.items.find(
                    (binding) =>
                      binding.repositoryId === null && binding.workflowKind === workflowKind,
                  );
            const globalKnown = repositoryId === null || globalQuery.isSuccess;
            const inherited =
              repositoryId !== null && !ownBinding && globalKnown && Boolean(globalBinding);
            const status = ownBinding
              ? repositoryId === null
                ? "Global default"
                : "Repository override"
              : inherited
                ? "Inherited global default"
                : globalKnown
                  ? "Unbound"
                  : globalQuery.isPending
                    ? "Loading global default"
                    : "Inheritance unavailable";

            return (
              <li className="prompt-bindings-item" key={workflowKind}>
                <div className="prompt-bindings-workflow">
                  <Typography.Text strong>{workflowLabels[workflowKind]}</Typography.Text>
                  <Tag color={ownBinding ? "blue" : inherited ? "green" : "default"}>{status}</Tag>
                </div>
                <div className="prompt-bindings-details">
                  <div className="prompt-bindings-value">
                    <span className="prompt-bindings-secondary">
                      {repositoryId === null ? "Global binding" : "Repository binding"}
                    </span>
                    {ownBinding ? (
                      <>
                        <VersionId value={ownBinding.promptVersionId} />
                        <span className="prompt-bindings-secondary">
                          Binding revision {ownBinding.version}
                        </span>
                      </>
                    ) : (
                      <span>
                        {repositoryId === null
                          ? "No global default is bound."
                          : "No repository override is bound."}
                      </span>
                    )}
                  </div>
                  {repositoryId !== null && (
                    <div className="prompt-bindings-value">
                      <span className="prompt-bindings-secondary">
                        Global default {ownBinding ? "(overridden)" : "(inherited when bound)"}
                      </span>
                      {!globalKnown ? (
                        <span>
                          {globalQuery.isPending
                            ? "Loading global default…"
                            : "Could not load global default."}
                        </span>
                      ) : globalBinding ? (
                        <>
                          <VersionId value={globalBinding.promptVersionId} />
                          <span className="prompt-bindings-secondary">
                            Global binding revision {globalBinding.version}
                          </span>
                        </>
                      ) : (
                        <span>No global default is bound.</span>
                      )}
                    </div>
                  )}
                </div>
                <div className="prompt-bindings-item-actions">
                  <Button
                    disabled={!available || bindingsQuery.isFetching}
                    onClick={() => setEditing({ workflowKind, binding: ownBinding })}
                    aria-label={`Change ${workflowLabels[workflowKind]} binding for ${scopeLabel}`}
                  >
                    {ownBinding
                      ? "Change binding"
                      : repositoryId === null
                        ? "Bind version"
                        : "Create override"}
                  </Button>
                  <Button
                    icon={<HistoryOutlined />}
                    disabled={!available}
                    onClick={() => setHistoryWorkflow(workflowKind)}
                  >
                    History
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing && (
        <BindingEditor
          key={`${repositoryId ?? "global"}:${editing.workflowKind}`}
          repositoryId={repositoryId}
          scopeLabel={scopeLabel}
          workflowKind={editing.workflowKind}
          initialBinding={editing.binding}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void messageApi.success(`Binding saved for ${workflowLabels[editing.workflowKind]}.`);
          }}
        />
      )}
      {historyWorkflow && (
        <BindingHistoryDrawer
          key={`${repositoryId ?? "global"}:${historyWorkflow}`}
          repositoryId={repositoryId}
          scopeLabel={scopeLabel}
          workflowKind={historyWorkflow}
          onClose={() => setHistoryWorkflow(null)}
        />
      )}
    </section>
  );
}

export function PromptBindings({
  repositoryId,
  scopeLabel,
}: {
  repositoryId: string | null;
  scopeLabel: string;
}) {
  const available = usePromptAvailable();
  const [activeScope, setActiveScope] = useState("repository");
  if (repositoryId === null)
    return <BindingsScope repositoryId={null} scopeLabel="Global defaults" />;

  return (
    <Tabs
      activeKey={activeScope}
      onChange={setActiveScope}
      destroyOnHidden
      items={[
        {
          key: "repository",
          label: "Repository overrides",
          disabled: !available,
          children: (
            <BindingsScope key={repositoryId} repositoryId={repositoryId} scopeLabel={scopeLabel} />
          ),
        },
        {
          key: "global",
          label: "Global defaults",
          disabled: !available,
          children: <BindingsScope key="global" repositoryId={null} scopeLabel="Global defaults" />,
        },
      ]}
    />
  );
}
