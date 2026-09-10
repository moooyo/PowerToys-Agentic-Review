import type {
  RepositoryValidationProfileBinding,
  ValidationProfileVersion,
  ValidationProfileVersionSummary,
} from "@agentic-review/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useEffect, useState } from "react";
import { useConfigurationAvailable } from "@/components/ConfigurationScopeGuard";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { configuration } from "@/services/configuration";
import type { ValidationProfileBindingHistory } from "@/services/configuration/adapter";
import {
  buildProfileBinding,
  collectProfileBindings,
  configurationErrorMessage,
  isProfileConflict,
  targetLabels,
  webTraceLabels,
  workflowLabels,
} from "./forms";

function PublishedVersion({ profile }: { profile: ValidationProfileVersion }) {
  const configurationJson = JSON.stringify(profile.config, null, 2);
  const observables = profile.config.test.flatMap((step) =>
    (step.probeOutput?.fields ?? []).map((field) => ({
      ...field,
      key: `${step.id}/${field.id}`,
      testStepId: step.id,
      testStepName: step.name,
    })),
  );
  return (
    <div className="validation-profiles-version">
      <Typography.Title level={5}>
        Version {profile.version} · {profile.name}
      </Typography.Title>
      <Descriptions
        column={1}
        size="small"
        items={[
          { key: "workflow", label: "Workflow", children: workflowLabels[profile.workflowKind] },
          { key: "target", label: "Execution target", children: targetLabels[profile.target] },
          { key: "required", label: "Required", children: profile.required ? "Yes" : "No" },
          ...(profile.config.ui?.target === "web"
            ? [
                {
                  key: "trace",
                  label: "Browser trace capture",
                  children: webTraceLabels[profile.config.ui.evidence.trace],
                },
              ]
            : []),
          {
            key: "schema",
            label: "Output schema",
            children: <code>{profile.outputSchemaVersion}</code>,
          },
          { key: "published", label: "Published", children: profile.publishedAt },
          { key: "author", label: "Published by", children: profile.createdBy },
          {
            key: "id",
            label: "Version ID",
            children: (
              <Typography.Text copyable code>
                {profile.id}
              </Typography.Text>
            ),
          },
          {
            key: "digest",
            label: "Configuration digest",
            children: (
              <Typography.Text copyable code>
                {profile.configSha256}
              </Typography.Text>
            ),
          },
        ]}
      />
      <Typography.Paragraph type="secondary">
        Published configuration is read-only. Create a new version to change commands or settings.
      </Typography.Paragraph>
      {profile.workflowKind !== "issue_triage" && (
        <div className="validation-profiles-notice">
          <Typography.Title level={5}>Test observables</Typography.Title>
          <Typography.Paragraph type="secondary">
            Issue reproduction cases can select these fields from this published version.
          </Typography.Paragraph>
          {observables.length === 0 ? (
            <Typography.Paragraph type="secondary">
              This version has no declared test observables.
            </Typography.Paragraph>
          ) : (
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              scroll={{ x: 600 }}
              dataSource={observables}
              columns={[
                {
                  title: "Test command",
                  key: "testStepId",
                  width: 180,
                  render: (_, field) => (
                    <>
                      {field.testStepName}
                      <div className="validation-profiles-secondary">
                        <code>{field.testStepId}</code>
                      </div>
                    </>
                  ),
                },
                {
                  title: "Field ID",
                  dataIndex: "id",
                  width: 150,
                  render: (id: string) => <Typography.Text code>{id}</Typography.Text>,
                },
                { title: "Type", dataIndex: "type", width: 90 },
                { title: "Description", dataIndex: "description" },
              ]}
            />
          )}
        </div>
      )}
      <textarea
        className="validation-profiles-json"
        readOnly
        wrap="off"
        rows={Math.min(24, configurationJson.split("\n").length)}
        style={{ width: "100%", resize: "vertical" }}
        aria-label={`Published configuration for version ${profile.version}`}
        value={configurationJson}
      />
    </div>
  );
}

export function ProfileDetails({
  repositoryId,
  profile,
  onClose,
  onNewVersion,
}: {
  repositoryId: string;
  profile: ValidationProfileVersionSummary;
  onClose: () => void;
  onNewVersion: () => void;
}) {
  const available = useConfigurationAvailable();
  const access = useOperatorAccess(repositoryId);
  const canConfigure = available && access.can("configure");
  const allowsConfigure = access.allows("configure");
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("versions");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(10);
  const [viewedVersionId, setViewedVersionId] = useState(profile.id);
  const [selected, setSelected] = useState<ValidationProfileVersionSummary>(profile);
  const [selectionReady, setSelectionReady] = useState(false);
  const [binding, setBinding] = useState<RepositoryValidationProfileBinding | undefined>();
  const [bindingLoaded, setBindingLoaded] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectingVersionId, setSelectingVersionId] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const versionsQuery = useQuery({
    queryKey: ["validation-profiles", repositoryId, profile.profileId, "versions", page, pageSize],
    queryFn: () =>
      configuration.listProfileVersions(repositoryId, profile.profileId, { page, pageSize }),
    retry: false,
  });
  const versionQuery = useQuery({
    queryKey: ["validation-profiles", repositoryId, profile.profileId, "version", viewedVersionId],
    queryFn: () =>
      configuration.getProfileVersion(repositoryId, profile.profileId, viewedVersionId),
    retry: false,
  });
  const bindingsQuery = useQuery({
    queryKey: ["validation-profiles", repositoryId, "bindings"],
    queryFn: () =>
      collectProfileBindings(repositoryId, (id, query) =>
        configuration.listProfileBindings(id, query),
      ),
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  const boundVersionQuery = useQuery({
    queryKey: [
      "validation-profiles",
      repositoryId,
      profile.profileId,
      "version",
      binding?.profileVersionId,
    ],
    queryFn: () => {
      if (!binding) throw new Error("Load the repository binding first.");
      return configuration.getProfileVersion(
        repositoryId,
        profile.profileId,
        binding.profileVersionId,
      );
    },
    enabled: binding !== undefined,
    retry: false,
  });
  const historyQuery = useQuery({
    queryKey: [
      "validation-profiles",
      repositoryId,
      profile.profileId,
      "binding-history",
      historyPage,
      historyPageSize,
    ],
    queryFn: () =>
      configuration.listProfileBindingHistory(repositoryId, profile.profileId, {
        page: historyPage,
        pageSize: historyPageSize,
      }),
    enabled: tab === "history",
    retry: false,
  });
  useEffect(() => {
    if (bindingsQuery.isSuccess && !bindingsQuery.isFetching && !bindingLoaded) {
      const current = bindingsQuery.data.find((item) => item.profileId === profile.profileId);
      setBinding(current);
      setEnabled(current?.enabled ?? true);
      setBindingLoaded(true);
    }
  }, [
    bindingLoaded,
    bindingsQuery.data,
    bindingsQuery.isSuccess,
    bindingsQuery.isFetching,
    profile.profileId,
  ]);
  useEffect(() => {
    if (!bindingLoaded || selectionReady) return;
    if (!binding) {
      setSelected(profile);
      setSelectionReady(true);
    } else if (boundVersionQuery.data && !boundVersionQuery.isError) {
      setSelected(boundVersionQuery.data);
      setSelectionReady(true);
    }
  }, [
    binding,
    bindingLoaded,
    boundVersionQuery.data,
    boundVersionQuery.isError,
    profile,
    selectionReady,
  ]);

  const reloadBinding = async () => {
    try {
      const result = await bindingsQuery.refetch({ throwOnError: true });
      if (!result.data) return;
      const current = result.data.find((item) => item.profileId === profile.profileId);
      setBinding(current);
      setEnabled(current?.enabled ?? true);
      setBindingLoaded(true);
      setConflict(false);
      setError(null);
      setSaved(false);
    } catch (failure) {
      setError(configurationErrorMessage(failure));
    }
  };
  const saveBinding = async () => {
    if (!canConfigure || saving || selectingVersionId !== null) return;
    if (
      !bindingLoaded ||
      !selectionReady ||
      bindingsQuery.isError ||
      bindingsQuery.isFetching ||
      conflict
    )
      return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await configuration.saveProfileBinding(
        repositoryId,
        profile.profileId,
        buildProfileBinding(repositoryId, profile.profileId, selected, enabled, binding),
      );
      setBinding(result);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["validation-profiles", repositoryId] });
    } catch (failure) {
      setConflict(isProfileConflict(failure));
      setError(configurationErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  const selectHistoricalVersion = async (versionId: string) => {
    if (!canConfigure || saving || selectingVersionId !== null) return;
    setSelectingVersionId(versionId);
    setError(null);
    try {
      const version = await configuration.getProfileVersion(
        repositoryId,
        profile.profileId,
        versionId,
      );
      setSelected(version);
      setSelectionReady(true);
      setSaved(false);
      setTab("binding");
    } catch (failure) {
      setError(configurationErrorMessage(failure));
    } finally {
      setSelectingVersionId(null);
    }
  };
  const mutationDisabled = saving || selectingVersionId !== null;
  const unchanged = binding?.profileVersionId === selected.id && binding.enabled === enabled;

  return (
    <Drawer
      open
      title={profile.name}
      size={920}
      onClose={onClose}
      closable={!mutationDisabled}
      mask={{ closable: !mutationDisabled }}
      keyboard={!mutationDisabled}
      extra={
        allowsConfigure && (
          <Button
            disabled={!canConfigure || mutationDisabled}
            onClick={() => {
              if (canConfigure) onNewVersion();
            }}
          >
            Create new version
          </Button>
        )
      }
    >
      <Typography.Paragraph type="secondary">
        {workflowLabels[profile.workflowKind]} · {targetLabels[profile.target]}
      </Typography.Paragraph>
      {profile.workflowKind === "pr_ui" || profile.workflowKind === "issue_validation" ? (
        <Alert
          className="validation-profiles-notice"
          type="info"
          showIcon
          title="Execution needs a matching driver"
          description="A Worker must have a driver for this workflow and target. A published or enabled profile is configuration, not evidence of a passed validation."
        />
      ) : null}
      {error && !conflict && (
        <Alert
          className="validation-profiles-notice"
          type="error"
          showIcon
          title="The request could not be completed"
          description={error}
        />
      )}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "versions",
            label: "Published versions",
            children: (
              <>
                {versionsQuery.isError ? (
                  <Alert
                    type="error"
                    showIcon
                    title="Could not load version history"
                    description={configurationErrorMessage(versionsQuery.error)}
                    action={<Button onClick={() => void versionsQuery.refetch()}>Try again</Button>}
                  />
                ) : (
                  <Table<ValidationProfileVersionSummary>
                    rowKey="id"
                    loading={versionsQuery.isPending}
                    dataSource={versionsQuery.data?.items ?? []}
                    size="small"
                    scroll={{ x: 660 }}
                    locale={{
                      emptyText: (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description="No published versions are available."
                        />
                      ),
                    }}
                    pagination={{
                      current: page,
                      pageSize,
                      total: versionsQuery.data?.total ?? 0,
                      showSizeChanger: true,
                      pageSizeOptions: [10, 20, 50],
                      onChange: (nextPage, nextSize) => {
                        setPage(nextSize === pageSize ? nextPage : 1);
                        setPageSize(nextSize);
                      },
                      showTotal: (total) => `${total} versions`,
                    }}
                    columns={[
                      {
                        title: "Version",
                        key: "version",
                        width: 95,
                        render: (_, item) => (
                          <Typography.Text strong>v{item.version}</Typography.Text>
                        ),
                      },
                      { title: "Name", dataIndex: "name", key: "name" },
                      {
                        title: "Published",
                        dataIndex: "publishedAt",
                        key: "published",
                        render: (value: string) => (
                          <span className="validation-profiles-date">{value}</span>
                        ),
                      },
                      {
                        title: "Actions",
                        key: "actions",
                        width: 210,
                        render: (_, item) => (
                          <Space>
                            <Button size="small" onClick={() => setViewedVersionId(item.id)}>
                              View
                            </Button>
                            {allowsConfigure && (
                              <Button
                                size="small"
                                disabled={!canConfigure || mutationDisabled}
                                onClick={() => {
                                  if (!canConfigure) return;
                                  setSelected(item);
                                  setSelectionReady(true);
                                  setSaved(false);
                                  setTab("binding");
                                }}
                              >
                                Use this version
                              </Button>
                            )}
                          </Space>
                        ),
                      },
                    ]}
                  />
                )}
                {versionQuery.isError ? (
                  <Alert
                    className="validation-profiles-notice"
                    type="error"
                    showIcon
                    title="Could not load this published version"
                    description={configurationErrorMessage(versionQuery.error)}
                    action={<Button onClick={() => void versionQuery.refetch()}>Try again</Button>}
                  />
                ) : versionQuery.isPending ? (
                  <Typography.Paragraph role="status">
                    Loading published configuration…
                  </Typography.Paragraph>
                ) : (
                  <PublishedVersion profile={versionQuery.data} />
                )}
              </>
            ),
          },
          {
            key: "binding",
            label: "Repository binding",
            children: (
              <>
                <Typography.Paragraph>
                  {allowsConfigure
                    ? "Choose the published version used for this repository. To roll back, select an older version in Published versions, then save this binding. Published content stays unchanged."
                    : "View the published version used for this repository. Repository configuration permission is required to change this binding."}
                </Typography.Paragraph>
                {bindingsQuery.isError ? (
                  <Alert
                    className="validation-profiles-notice"
                    type="error"
                    showIcon
                    title="Could not load current bindings"
                    description={configurationErrorMessage(bindingsQuery.error)}
                    action={
                      <Button loading={bindingsQuery.isFetching} onClick={reloadBinding}>
                        Reload bindings
                      </Button>
                    }
                  />
                ) : !bindingLoaded ? (
                  <Typography.Paragraph role="status">
                    Loading current binding…
                  </Typography.Paragraph>
                ) : (
                  <Descriptions
                    column={1}
                    size="small"
                    className="validation-profiles-notice"
                    items={[
                      {
                        key: "current",
                        label: "Current version",
                        children: binding ? (
                          <>
                            {boundVersionQuery.data ? (
                              `v${boundVersionQuery.data.version} · ${boundVersionQuery.data.name}`
                            ) : (
                              <code>{binding.profileVersionId}</code>
                            )}{" "}
                            <Tag>{binding.enabled ? "Enabled" : "Disabled"}</Tag>
                          </>
                        ) : (
                          "Not bound"
                        ),
                      },
                      {
                        key: "revision",
                        label: "Binding revision",
                        children: binding?.version ?? "No binding yet",
                      },
                    ]}
                  />
                )}
                {boundVersionQuery.isError && binding && (
                  <Alert
                    className="validation-profiles-notice"
                    type="error"
                    showIcon
                    title="Could not load the bound version"
                    description={configurationErrorMessage(boundVersionQuery.error)}
                    action={
                      <Button onClick={() => void boundVersionQuery.refetch()}>Try again</Button>
                    }
                  />
                )}
                {conflict && (
                  <Alert
                    className="validation-profiles-notice"
                    type="warning"
                    showIcon
                    title="The repository binding changed"
                    description={
                      <>
                        <p>{error}</p>
                        <p>
                          Reload the current binding, review the selected version and enabled state,
                          then save again.
                        </p>
                      </>
                    }
                    action={
                      <Button loading={bindingsQuery.isFetching} onClick={reloadBinding}>
                        Reload current binding
                      </Button>
                    }
                  />
                )}
                {saved && (
                  <Alert
                    className="validation-profiles-notice"
                    type="success"
                    showIcon
                    title="Repository binding saved"
                    description="This updates configuration for future work. It does not start or confirm a validation run."
                  />
                )}
                {allowsConfigure && (
                  <>
                    <div className="validation-profiles-binding-choice">
                      <div>
                        <Typography.Text strong>Version to bind</Typography.Text>
                        <Typography.Paragraph>
                          {selectionReady
                            ? `v${selected.version} · ${selected.name}`
                            : "Loading current version…"}
                        </Typography.Paragraph>
                        {selectionReady && (
                          <Typography.Text type="secondary">{selected.id}</Typography.Text>
                        )}
                      </div>
                      <Button
                        disabled={!canConfigure || mutationDisabled}
                        onClick={() => {
                          if (canConfigure) setTab("versions");
                        }}
                      >
                        Choose another version
                      </Button>
                    </div>
                    <div className="validation-profiles-binding-choice">
                      <div>
                        <label htmlFor="profile-binding-enabled">Enable this profile</label>
                        <Typography.Paragraph type="secondary">
                          Allow future work to select this profile through the repository binding.
                        </Typography.Paragraph>
                      </div>
                      <Switch
                        id="profile-binding-enabled"
                        checked={enabled}
                        disabled={
                          !canConfigure ||
                          !bindingLoaded ||
                          bindingsQuery.isError ||
                          mutationDisabled ||
                          conflict
                        }
                        onChange={(value) => {
                          if (!canConfigure) return;
                          setEnabled(value);
                          setSaved(false);
                        }}
                      />
                    </div>
                    <Button
                      type="primary"
                      loading={saving}
                      disabled={
                        !canConfigure ||
                        !bindingLoaded ||
                        !selectionReady ||
                        bindingsQuery.isError ||
                        bindingsQuery.isFetching ||
                        conflict ||
                        unchanged ||
                        selectingVersionId !== null
                      }
                      onClick={saveBinding}
                    >
                      Save repository binding
                    </Button>
                  </>
                )}
              </>
            ),
          },
          {
            key: "history",
            label: "Binding history",
            children: historyQuery.isError ? (
              <Alert
                type="error"
                showIcon
                title="Could not load binding history"
                description={configurationErrorMessage(historyQuery.error)}
                action={<Button onClick={() => void historyQuery.refetch()}>Try again</Button>}
              />
            ) : (
              <Table<ValidationProfileBindingHistory>
                rowKey="id"
                size="small"
                loading={historyQuery.isPending}
                dataSource={historyQuery.data?.items ?? []}
                scroll={{ x: 720 }}
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="This profile has no binding history yet."
                    />
                  ),
                }}
                pagination={{
                  current: historyPage,
                  pageSize: historyPageSize,
                  total: historyQuery.data?.total ?? 0,
                  showSizeChanger: true,
                  pageSizeOptions: [10, 20, 50],
                  onChange: (nextPage, nextSize) => {
                    setHistoryPage(nextSize === historyPageSize ? nextPage : 1);
                    setHistoryPageSize(nextSize);
                  },
                  showTotal: (total) => `${total} changes`,
                }}
                columns={[
                  { title: "Revision", dataIndex: "version", key: "version", width: 85 },
                  {
                    title: "Version ID",
                    key: "profileVersionId",
                    render: (_, item) => (
                      <Typography.Text code copyable>
                        {item.profileVersionId}
                      </Typography.Text>
                    ),
                  },
                  {
                    title: "State",
                    key: "enabled",
                    width: 95,
                    render: (_, item) => <Tag>{item.enabled ? "Enabled" : "Disabled"}</Tag>,
                  },
                  {
                    title: "Changed",
                    key: "createdAt",
                    render: (_, item) => (
                      <>
                        <span className="validation-profiles-date">{item.createdAt}</span>
                        <div className="validation-profiles-secondary">{item.createdBy}</div>
                      </>
                    ),
                  },
                  {
                    title: "Actions",
                    key: "actions",
                    width: 145,
                    render: (_, item) =>
                      allowsConfigure && (
                        <Button
                          size="small"
                          disabled={!canConfigure || mutationDisabled}
                          loading={selectingVersionId === item.profileVersionId}
                          onClick={() => void selectHistoricalVersion(item.profileVersionId)}
                        >
                          Use this version
                        </Button>
                      ),
                  },
                ]}
              />
            ),
          },
        ]}
      />
    </Drawer>
  );
}
