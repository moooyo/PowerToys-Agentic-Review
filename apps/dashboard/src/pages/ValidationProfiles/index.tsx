import type {
  ValidationProfileVersion,
  ValidationProfileVersionSummary,
} from "@agentic-review/contracts";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Empty, message, Space, Table, Tag, Typography } from "antd";
import { useState } from "react";
import {
  ConfigurationScopeGuard,
  useConfigurationAvailable,
} from "@/components/ConfigurationScopeGuard";
import { OperatorAccessGate, useOperatorAccess } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import { RepositoryScopeUnavailable, useRepositoryScope } from "@/components/RepositoryScope";
import { configuration } from "@/services/configuration";
import {
  collectProfileBindings,
  configurationErrorMessage,
  targetLabels,
  workflowLabels,
} from "./forms";
import { ProfileDetails } from "./ProfileDetails";
import { ProfileEditor } from "./ProfileEditor";
import "./index.css";

function RepositoryProfiles({
  repositoryId,
  repositoryName,
}: {
  repositoryId: string;
  repositoryName: string;
}) {
  const available = useConfigurationAvailable();
  const access = useOperatorAccess(repositoryId);
  const canConfigure = available && access.can("configure");
  const allowsConfigure = access.allows("configure");
  const queryClient = useQueryClient();
  const [messageApi, messageContext] = message.useMessage();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [detail, setDetail] = useState<ValidationProfileVersionSummary | null>(null);
  const [editor, setEditor] = useState<{ source?: ValidationProfileVersionSummary } | null>(null);
  const listQuery = useQuery({
    queryKey: ["validation-profiles", repositoryId, "list", page, pageSize],
    queryFn: () => configuration.listProfiles(repositoryId, { page, pageSize }),
    retry: false,
  });
  const bindingsQuery = useQuery({
    queryKey: ["validation-profiles", repositoryId, "bindings"],
    queryFn: () =>
      collectProfileBindings(repositoryId, (id, query) =>
        configuration.listProfileBindings(id, query),
      ),
    retry: false,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["validation-profiles", repositoryId] });
  const createProfile = () => {
    if (canConfigure) setEditor({});
  };
  const createVersion = (source: ValidationProfileVersionSummary) => {
    if (!canConfigure) return;
    setEditor({ source });
    setDetail(null);
  };
  const published = (profile: ValidationProfileVersion) => {
    setEditor(null);
    setDetail(profile);
    void messageApi.success(
      `Version ${profile.version} published. Select a repository binding to use it.`,
    );
    void refresh();
  };

  return (
    <section className="validation-profiles-page" aria-labelledby="validation-profiles-title">
      {messageContext}
      <PageHeader
        eyebrow="Configuration"
        title="Validation profiles"
        titleId="validation-profiles-title"
        description={`Manage workflow commands and published versions for ${repositoryName}.`}
        actions={
          <Space>
            <Button
              icon={<ReloadOutlined />}
              loading={listQuery.isFetching || bindingsQuery.isFetching}
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
            {allowsConfigure && (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={!canConfigure}
                onClick={createProfile}
              >
                Create profile
              </Button>
            )}
          </Space>
        }
      />
      {process.env.NODE_ENV === "development" && (
        <Alert
          className="validation-profiles-notice"
          type="info"
          showIcon
          title="Sample data"
          description="This preview uses sample profiles. Changes affect the preview only and do not execute commands."
        />
      )}
      <Typography.Paragraph type="secondary">
        {allowsConfigure
          ? "Publish a version, then bind it to this repository. Published versions stay read-only; bindings control which version is enabled for future work."
          : "View published workflow configurations and repository bindings. Repository configuration permission is required to publish versions or change bindings."}
      </Typography.Paragraph>
      {bindingsQuery.isError && (
        <Alert
          className="validation-profiles-notice"
          type="error"
          showIcon
          title="Current bindings are unavailable"
          description={configurationErrorMessage(bindingsQuery.error)}
          action={<Button onClick={() => void bindingsQuery.refetch()}>Reload bindings</Button>}
        />
      )}
      <Card
        className="validation-profiles-panel"
        title="Profiles"
        extra={
          <Typography.Text type="secondary">
            {listQuery.isFetching
              ? "Loading profiles…"
              : listQuery.isError
                ? "Profiles unavailable"
                : `${listQuery.data?.total ?? 0} profiles`}
          </Typography.Text>
        }
      >
        {listQuery.isError ? (
          <Alert
            type="error"
            showIcon
            title="Could not load validation profiles"
            description={configurationErrorMessage(listQuery.error)}
            action={<Button onClick={() => void listQuery.refetch()}>Try again</Button>}
          />
        ) : (
          <Table<ValidationProfileVersionSummary>
            rowKey="profileId"
            dataSource={listQuery.data?.items ?? []}
            loading={listQuery.isPending}
            scroll={{ x: 1000 }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    allowsConfigure
                      ? "Create a profile to define how this repository is validated."
                      : "No validation profiles are available for this repository."
                  }
                >
                  {allowsConfigure && (
                    <Button type="primary" disabled={!canConfigure} onClick={createProfile}>
                      Create profile
                    </Button>
                  )}
                </Empty>
              ),
            }}
            pagination={{
              current: page,
              pageSize,
              total: listQuery.data?.total ?? 0,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50],
              onChange: (nextPage, nextSize) => {
                setPage(nextSize === pageSize ? nextPage : 1);
                setPageSize(nextSize);
              },
              showTotal: (total, range) => `${range[0]}–${range[1]} of ${total} profiles`,
            }}
            columns={[
              {
                title: "Profile",
                key: "name",
                render: (_, item) => (
                  <>
                    <Button
                      className="validation-profiles-name"
                      type="link"
                      onClick={() => setDetail(item)}
                    >
                      {item.name}
                    </Button>
                    <div className="validation-profiles-secondary">
                      Latest version {item.version} · {item.required ? "Required" : "Optional"}
                    </div>
                  </>
                ),
              },
              {
                title: "Workflow",
                dataIndex: "workflowKind",
                key: "workflowKind",
                render: (value: ValidationProfileVersionSummary["workflowKind"]) =>
                  workflowLabels[value],
              },
              {
                title: "Target",
                dataIndex: "target",
                key: "target",
                render: (value: ValidationProfileVersionSummary["target"]) => targetLabels[value],
              },
              {
                title: "Repository binding",
                key: "binding",
                render: (_, item) => {
                  if (bindingsQuery.isError)
                    return <Typography.Text type="danger">Unavailable</Typography.Text>;
                  if (bindingsQuery.isPending)
                    return <Typography.Text type="secondary">Loading…</Typography.Text>;
                  const binding = bindingsQuery.data?.find(
                    (candidate) => candidate.profileId === item.profileId,
                  );
                  return binding ? (
                    <>
                      <Tag color={binding.enabled ? "processing" : "default"}>
                        {binding.enabled ? "Enabled" : "Disabled"}
                      </Tag>
                      <div className="validation-profiles-secondary">
                        {binding.profileVersionId === item.id
                          ? `Version ${item.version}`
                          : "Different published version"}
                      </div>
                    </>
                  ) : (
                    <Tag>Not bound</Tag>
                  );
                },
              },
              {
                title: "Published",
                dataIndex: "publishedAt",
                key: "publishedAt",
                render: (value: string) => (
                  <span className="validation-profiles-date">{value}</span>
                ),
              },
              {
                title: "Actions",
                key: "actions",
                width: 230,
                render: (_, item) => (
                  <Space>
                    <Button onClick={() => setDetail(item)}>
                      {allowsConfigure ? "Manage" : "View"}
                    </Button>
                    {allowsConfigure && (
                      <Button disabled={!canConfigure} onClick={() => createVersion(item)}>
                        New version
                      </Button>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>
      {detail && (
        <ProfileDetails
          key={detail.profileId}
          repositoryId={repositoryId}
          profile={detail}
          onClose={() => setDetail(null)}
          onNewVersion={() => createVersion(detail)}
        />
      )}
      {editor && (
        <ProfileEditor
          key={editor.source?.profileId ?? "create"}
          repositoryId={repositoryId}
          {...(editor.source ? { source: editor.source } : {})}
          onClose={() => setEditor(null)}
          onPublished={published}
        />
      )}
    </section>
  );
}

export default function ValidationProfilesPage() {
  const scope = useRepositoryScope();
  if (scope.ready && !scope.repositoryId)
    return (
      <section className="validation-profiles-page" aria-labelledby="validation-profiles-title">
        <PageHeader
          eyebrow="Configuration"
          title="Validation profiles"
          titleId="validation-profiles-title"
          description="Choose a repository to manage its workflow commands and published versions."
        />
        <Card>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Select a specific repository in the sidebar to view, publish, or bind validation profiles."
          />
        </Card>
      </section>
    );
  return (
    <OperatorAccessGate repositoryId={scope.repositoryId}>
      <ConfigurationScopeGuard
        key={scope.key}
        scopeKey={scope.key}
        available={scope.ready && !scope.error && scope.repositoryId !== undefined}
        fallback={<RepositoryScopeUnavailable />}
      >
        <RepositoryProfiles
          key={scope.key}
          repositoryId={scope.repositoryId ?? ""}
          repositoryName={scope.label}
        />
      </ConfigurationScopeGuard>
    </OperatorAccessGate>
  );
}
