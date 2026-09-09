import type {
  GitHubRepository,
  ManagedRepository,
  ManagedRepositorySummary,
} from "@agentic-review/contracts";
import {
  CheckCircleOutlined,
  GithubOutlined,
  PlusOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useModel } from "@umijs/max";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  message,
  Pagination,
  Select,
  Skeleton,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { RepositoryConfigurationActivity } from "@/components/ConfigurationAudit";
import { configurationAuditQueryRoot } from "@/components/ConfigurationAudit/state";
import { OperatorAccessGate, useOperatorAccess } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import { PublicationPolicy } from "@/components/PublicationPolicy";
import { RepositoryAccessDrawer } from "@/components/RepositoryAccess";
import { RepositorySchedulingPolicy } from "@/components/SchedulingPolicy";
import { SchedulingLimitFields } from "@/components/SchedulingPolicy/LimitFields";
import { repositories } from "@/services/repositories";
import { schedulingPolicyQueryRoot } from "@/services/scheduling-policy";
import {
  buildRepositoryUpdate,
  isConfigurationConflict,
  parseAllowlistedActors,
  parsePositiveSafeInteger,
  type RepositorySettingsValues,
  repositorySettingsValues,
} from "./form";
import "./index.css";

const connectionLabels = { unknown: "Not checked", ready: "Connected", error: "Connection error" };
const repositoryNamePattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/u;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed. Try again.";
}

function Connection({ repository }: { repository: ManagedRepositorySummary }) {
  return (
    <div className="repositories-connection">
      <Tag
        color={
          repository.connectionStatus === "ready"
            ? "success"
            : repository.connectionStatus === "error"
              ? "error"
              : "default"
        }
      >
        {connectionLabels[repository.connectionStatus]}
      </Tag>
      <span className="repositories-secondary">
        {repository.connectionMessage ??
          (repository.connectionStatus === "unknown"
            ? "Run a connection check to verify GitHub access."
            : repository.connectionStatus === "ready"
              ? "GitHub access verified."
              : "Check the repository configuration and try again.")}
      </span>
    </div>
  );
}

function AddRepositoryDrawer({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (repository: ManagedRepository) => void;
}) {
  const operatorAccess = useOperatorAccess();
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [resolved, setResolved] = useState<GitHubRepository | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [creating, setCreating] = useState(false);
  const generation = useRef(0);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const resolve = async () => {
    if (!operatorAccess.platformAdministrator || operatorAccess.checking) return;
    const fullName = name.trim();
    if (!repositoryNamePattern.test(fullName)) {
      setError("Enter a GitHub repository in owner/repository format.");
      return;
    }
    const request = ++generation.current;
    setResolving(true);
    setResolved(null);
    setError(null);
    try {
      const result = await repositories.resolve(fullName);
      if (request === generation.current) setResolved(result);
    } catch (failure) {
      if (request === generation.current) setError(errorMessage(failure));
    } finally {
      if (request === generation.current) setResolving(false);
    }
  };

  const create = async () => {
    if (!resolved || !operatorAccess.platformAdministrator || operatorAccess.checking) return;
    setCreating(true);
    setError(null);
    try {
      const result = await repositories.create({
        fullName: resolved.fullName,
        githubRepositoryId: resolved.githubRepositoryId,
        enabled,
      });
      onCreated(result);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Drawer
      open
      title="Add repository"
      size={560}
      onClose={onClose}
      closable={!creating}
      mask={{ closable: !creating }}
      keyboard={!creating}
      footer={
        <div className="repositories-drawer-actions">
          <Button disabled={creating} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="primary"
            disabled={
              !resolved ||
              resolving ||
              !operatorAccess.platformAdministrator ||
              operatorAccess.checking
            }
            loading={creating}
            onClick={create}
          >
            Add repository
          </Button>
        </div>
      }
    >
      <Typography.Paragraph type="secondary">
        Find a repository on GitHub, then add it to your review workspace.
      </Typography.Paragraph>
      <Form layout="vertical">
        <Form.Item label="GitHub repository" htmlFor="repository-full-name" required>
          <Space.Compact className="repositories-full-width">
            <Input
              id="repository-full-name"
              placeholder="owner/repository"
              maxLength={201}
              disabled={creating}
              value={name}
              onChange={(event) => {
                generation.current += 1;
                setName(event.target.value);
                setResolved(null);
                setResolving(false);
                setError(null);
              }}
              onPressEnter={() => void resolve()}
            />
            <Button
              loading={resolving}
              disabled={
                creating ||
                !name.trim() ||
                !operatorAccess.platformAdministrator ||
                operatorAccess.checking
              }
              onClick={resolve}
            >
              Find repository
            </Button>
          </Space.Compact>
        </Form.Item>
        {error && (
          <Alert
            className="repositories-notice"
            showIcon
            type="error"
            title="Could not add repository"
            description={error}
          />
        )}
        {resolved && (
          <Card size="small" className="repositories-resolved">
            <div className="repositories-resolved-heading">
              <CheckCircleOutlined className="repositories-resolved-icon" />
              <Typography.Text strong>Repository found</Typography.Text>
            </div>
            <Descriptions
              column={1}
              size="small"
              items={[
                {
                  key: "name",
                  label: "Repository",
                  children: (
                    <a href={resolved.htmlUrl} target="_blank" rel="noreferrer">
                      {resolved.fullName}
                    </a>
                  ),
                },
                {
                  key: "visibility",
                  label: "Visibility",
                  children: resolved.isPrivate ? "Private" : "Public",
                },
                {
                  key: "branch",
                  label: "Default branch",
                  children: <code>{resolved.defaultBranch}</code>,
                },
                {
                  key: "id",
                  label: "GitHub repository ID",
                  children: <code>{resolved.githubRepositoryId}</code>,
                },
              ]}
            />
          </Card>
        )}
        <div className="repositories-setting-row">
          <div>
            <label htmlFor="repository-create-enabled">Enable repository</label>
            <p>Allow this repository to participate in synchronization and scheduling.</p>
          </div>
          <Switch
            id="repository-create-enabled"
            checked={enabled}
            onChange={setEnabled}
            disabled={creating}
          />
        </div>
        <Typography.Paragraph type="secondary">
          New repositories inherit the default reviewer and authorization policy. You can change
          these after adding the repository.
        </Typography.Paragraph>
      </Form>
    </Drawer>
  );
}

function positiveIntegerRule(label: string, required = true) {
  return {
    validator: async (_: unknown, value: string | undefined) => {
      if (!required && !value?.trim()) return;
      parsePositiveSafeInteger(value ?? "", label);
    },
  };
}

function RepositorySettingsDrawer({
  repositoryId,
  onClose,
  onSaved,
}: {
  repositoryId: string;
  onClose: () => void;
  onSaved: (repository: ManagedRepository) => void;
}) {
  const operatorAccess = useOperatorAccess(repositoryId);
  const { initialState } = useModel("@@initialState");
  const [form] = Form.useForm<RepositorySettingsValues>();
  const [baseline, setBaseline] = useState<ManagedRepository | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [dirty, setDirty] = useState(false);
  const reviewerMode = Form.useWatch("reviewerMode", form);
  const policyMode = Form.useWatch("policyMode", form);
  const repositoryQuery = useQuery({
    queryKey: [
      "managed-repositories",
      "detail",
      repositoryId,
      ...operatorAccess.identityKey,
      initialState?.authenticationEpoch ?? 0,
    ],
    queryFn: ({ signal }) => repositories.get(repositoryId, signal),
    enabled: operatorAccess.can("configure"),
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (repositoryQuery.data && !baseline) {
      setBaseline(repositoryQuery.data);
      form.setFieldsValue(repositorySettingsValues(repositoryQuery.data));
    }
  }, [repositoryQuery.data, baseline, form]);

  const reloadLatest = async () => {
    try {
      const result = await repositoryQuery.refetch({ throwOnError: true });
      if (!result.data) return;
      setBaseline(result.data);
      form.setFieldsValue(repositorySettingsValues(result.data));
      setConflict(false);
      setDirty(false);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const save = async (values: RepositorySettingsValues) => {
    if (!baseline || !dirty || conflict || !operatorAccess.can("configure")) return;
    setSaving(true);
    setError(null);
    try {
      const result = await repositories.update(
        repositoryId,
        buildRepositoryUpdate(values, baseline.version),
      );
      onSaved(result);
    } catch (failure) {
      setConflict(isConfigurationConflict(failure));
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open
      title={baseline ? `Settings · ${baseline.fullName}` : "Repository settings"}
      size={600}
      onClose={onClose}
      closable={!saving}
      mask={{ closable: !saving }}
      keyboard={!saving}
      footer={
        <div className="repositories-drawer-actions">
          <Button disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="primary"
            loading={saving}
            disabled={
              !baseline ||
              !dirty ||
              conflict ||
              repositoryQuery.isFetching ||
              !operatorAccess.can("configure")
            }
            onClick={() => form.submit()}
          >
            Save changes
          </Button>
        </div>
      }
    >
      {!baseline && repositoryQuery.isPending && <Skeleton active paragraph={{ rows: 8 }} />}
      {!baseline && repositoryQuery.isError && (
        <Alert
          type="error"
          showIcon
          title="Could not load repository settings"
          description={errorMessage(repositoryQuery.error)}
          action={<Button onClick={reloadLatest}>Try again</Button>}
        />
      )}
      {baseline && (
        <Form
          form={form}
          layout="vertical"
          onFinish={save}
          onValuesChange={() => setDirty(true)}
          disabled={saving || !operatorAccess.can("configure")}
        >
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: "repository", label: "Repository", children: baseline.fullName },
              {
                key: "github-id",
                label: "GitHub repository ID",
                children: <code>{baseline.githubRepositoryId}</code>,
              },
            ]}
          />
          <Divider />
          {conflict ? (
            <Alert
              className="repositories-notice"
              showIcon
              type="warning"
              title="These settings changed while you were editing"
              description={
                <>
                  <p>{error}</p>
                  <p>
                    Your changes have not been saved. Reload the latest settings, then reapply your
                    changes. Reloading replaces this draft.
                  </p>
                </>
              }
              action={
                <Button loading={repositoryQuery.isFetching} onClick={reloadLatest}>
                  Reload latest settings
                </Button>
              }
            />
          ) : error ? (
            <Alert
              className="repositories-notice"
              showIcon
              type="error"
              title="Could not save changes"
              description={error}
            />
          ) : null}
          <Form.Item
            name="enabled"
            label="Enable repository"
            valuePropName="checked"
            extra="Disabled repositories do not participate in new synchronization or scheduling."
          >
            <Switch />
          </Form.Item>
          <Divider />
          <Typography.Title level={5}>Scheduling</Typography.Title>
          <SchedulingLimitFields />
          <Typography.Paragraph type="secondary">
            Unlimited at repository scope still obeys global limits and Worker constraints.
          </Typography.Paragraph>
          <Divider />
          <Typography.Title level={5}>Reviewer</Typography.Title>
          <Form.Item name="reviewerMode" label="Reviewer configuration">
            <Select
              options={[
                { value: "inherit", label: "Inherit default reviewer" },
                { value: "custom", label: "Configure for this repository" },
              ]}
            />
          </Form.Item>
          {reviewerMode === "custom" ? (
            <>
              <Form.Item
                name="reviewerGithubUserId"
                label="Reviewer GitHub user ID"
                required
                rules={[positiveIntegerRule("Reviewer ID")]}
                extra="Numeric identity used for scheduling. Configure the ID and login together."
              >
                <Input inputMode="numeric" placeholder="e.g. 12345678" maxLength={16} />
              </Form.Item>
              <Form.Item
                name="reviewerGithubLogin"
                label="Reviewer GitHub login"
                rules={[
                  { required: true, message: "Enter the reviewer login." },
                  {
                    pattern: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u,
                    message:
                      "Use up to 39 letters, numbers, or hyphens, starting with a letter or number.",
                  },
                ]}
                extra="The login of the configured reviewer account. The numeric ID determines authorization."
              >
                <Input placeholder="e.g. review-bot" maxLength={39} />
              </Form.Item>
            </>
          ) : (
            <Typography.Paragraph type="secondary">
              Uses the server's default reviewer ID and login.
            </Typography.Paragraph>
          )}
          <Divider />
          <Typography.Title level={5}>Authorization</Typography.Title>
          <Form.Item name="policyMode" label="Authorization policy">
            <Select
              options={[
                { value: "inherit", label: "Inherit default policy" },
                { value: "custom", label: "Self or allowlisted actors" },
              ]}
            />
          </Form.Item>
          {policyMode === "custom" ? (
            <>
              {reviewerMode === "inherit" && (
                <Alert
                  className="repositories-notice"
                  type="warning"
                  showIcon
                  title="Configure a reviewer above to use a custom authorization policy."
                />
              )}
              <Typography.Paragraph type="secondary">
                The configured reviewer can authorize requests for itself. Allowlisted actors can
                also authorize requests for this reviewer. Unknown actors are always denied.
              </Typography.Paragraph>
              <Form.Item
                name="schedulingTargetGithubUserId"
                label="Scheduling target GitHub user ID"
                rules={[positiveIntegerRule("Scheduling target ID")]}
                required
                extra="Must match the configured reviewer ID above. This account receives review requests and assignments."
              >
                <Input inputMode="numeric" placeholder="GitHub user ID" maxLength={16} />
              </Form.Item>
              <Form.Item
                name="allowlistedActorGithubUserIds"
                label="Allowlisted actor IDs"
                rules={[
                  {
                    validator: async (_: unknown, value: string | undefined) => {
                      parseAllowlistedActors(value ?? "");
                    },
                  },
                ]}
                extra="Enter numeric GitHub user IDs, one per line or separated by commas. An empty list permits only self-requests."
              >
                <Input.TextArea
                  autoSize={{ minRows: 3, maxRows: 8 }}
                  placeholder={"12345678\n87654321"}
                  className="repositories-code-input"
                />
              </Form.Item>
              <Form.Item name="newRevisionPolicy" label="When a pull request receives new commits">
                <Select
                  options={[
                    { value: "default", label: "Default: require a new authorization" },
                    { value: "require_new_authorization", label: "Require a new authorization" },
                    {
                      value: "inherit_authorized_epoch",
                      label: "Carry authorization forward while the request is active",
                    },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name="policyVersion"
                label="Policy version"
                rules={[positiveIntegerRule("Policy version")]}
                required
                extra="Version recorded with authorization decisions. Set this explicitly when revising your policy."
              >
                <Input inputMode="numeric" maxLength={16} />
              </Form.Item>
            </>
          ) : (
            <Typography.Paragraph type="secondary">
              Uses the server's default authorization policy, including who may request reviews and
              how new commits are authorized.
            </Typography.Paragraph>
          )}
        </Form>
      )}
    </Drawer>
  );
}

function RepositoryManagement({
  repository,
  onUpdated,
}: {
  repository: ManagedRepositorySummary;
  onUpdated: () => void;
}) {
  const operatorAccess = useOperatorAccess(repository.id);
  const { initialState } = useModel("@@initialState");
  const queryClient = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const checkConnection = async () => {
    if (!operatorAccess.can("configure") || checking) return;
    setChecking(true);
    setConnectionNotice(null);
    try {
      const result = await repositories.checkConnection(repository.id);
      setConnectionNotice({
        success: result.connectionStatus === "ready",
        message:
          result.connectionStatus === "ready"
            ? `Connection verified for ${result.fullName}.`
            : (result.connectionMessage ?? "The connection could not be verified."),
      });
      onUpdated();
    } catch (error) {
      setConnectionNotice({ success: false, message: errorMessage(error) });
    } finally {
      setChecking(false);
    }
  };
  const refreshAccess = () => {
    void queryClient.invalidateQueries({ queryKey: ["operator-access"] });
    onUpdated();
  };
  return (
    <Space orientation="vertical" size="large" className="repositories-full-width">
      <Descriptions
        column={1}
        size="small"
        items={[
          { key: "repository", label: "Repository", children: repository.fullName },
          {
            key: "role",
            label: "Your access",
            children: operatorAccess.platformAdministrator
              ? "Platform administrator"
              : operatorAccess.context?.repository?.role,
          },
          {
            key: "connection",
            label: "Connection",
            children: <Connection repository={repository} />,
          },
        ]}
      />
      {!operatorAccess.allows("configure") ? (
        <Alert
          type="info"
          showIcon
          title="Read-only repository settings"
          description="Maintainer access or higher is required to change repository settings and verify the connection."
        />
      ) : null}
      <Space wrap>
        <Button
          disabled={!operatorAccess.can("configure")}
          loading={checking}
          onClick={() => void checkConnection()}
        >
          Check connection
        </Button>
        <Button disabled={!operatorAccess.can("configure")} onClick={() => setSettingsOpen(true)}>
          Settings
        </Button>
        <Button disabled={!operatorAccess.can("manage_access")} onClick={() => setAccessOpen(true)}>
          Members and access
        </Button>
      </Space>
      {!operatorAccess.allows("manage_access") ? (
        <Typography.Paragraph type="secondary">
          Repository administrators manage members and access history.
        </Typography.Paragraph>
      ) : null}
      {connectionNotice ? (
        <Alert
          showIcon
          type={connectionNotice.success ? "success" : "error"}
          title={connectionNotice.success ? "Connection verified" : "Connection check failed"}
          description={connectionNotice.message}
        />
      ) : null}
      <RepositoryConfigurationActivity repositoryId={repository.id} />
      <RepositorySchedulingPolicy repositoryId={repository.id} />
      <PublicationPolicy repositoryId={repository.id} />
      {settingsOpen ? (
        <OperatorAccessGate repositoryId={repository.id} permission="configure">
          <RepositorySettingsDrawer
            key={JSON.stringify([
              repository.id,
              operatorAccess.identityKey,
              initialState?.authenticationEpoch ?? 0,
              operatorAccess.context?.repository,
              operatorAccess.platformAdministrator,
            ])}
            repositoryId={repository.id}
            onClose={() => setSettingsOpen(false)}
            onSaved={() => {
              setSettingsOpen(false);
              void queryClient.invalidateQueries({ queryKey: configurationAuditQueryRoot });
              void queryClient.invalidateQueries({ queryKey: schedulingPolicyQueryRoot });
              void queryClient.invalidateQueries({ queryKey: ["scheduling-diagnostics"] });
              onUpdated();
            }}
          />
        </OperatorAccessGate>
      ) : null}
      {accessOpen && operatorAccess.principal ? (
        <RepositoryAccessDrawer
          repositoryId={repository.id}
          repositoryName={repository.fullName}
          open
          onClose={() => setAccessOpen(false)}
          canManage={operatorAccess.allows("manage_access")}
          platformAdministrator={operatorAccess.platformAdministrator}
          currentPrincipal={operatorAccess.principal}
          onChanged={refreshAccess}
        />
      ) : null}
    </Space>
  );
}

export default function RepositoriesPage() {
  return (
    <OperatorAccessGate>
      <RepositoriesContent />
    </OperatorAccessGate>
  );
}

function RepositoriesContent() {
  const operatorAccess = useOperatorAccess();
  const queryClient = useQueryClient();
  const [messageApi, messageContext] = message.useMessage();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<ManagedRepositorySummary | null>(null);
  const listQuery = useQuery({
    queryKey: [
      "managed-repositories",
      "list",
      ...operatorAccess.identityKey,
      { page, pageSize, search },
    ],
    queryFn: () => repositories.list({ page, pageSize, search }),
  });
  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;

  useEffect(() => {
    if (listQuery.data && total > 0 && page > Math.ceil(total / pageSize)) {
      setPage(Math.ceil(total / pageSize));
    }
  }, [listQuery.data, total, page, pageSize]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["managed-repositories"] });

  return (
    <section className="repositories-page" aria-labelledby="repositories-page-title">
      {messageContext}
      <PageHeader
        eyebrow="Configuration"
        title="Repositories"
        titleId="repositories-page-title"
        description="Connect GitHub repositories and control who can request reviews."
        actions={
          <Space>
            <Button icon={<ReloadOutlined />} loading={listQuery.isFetching} onClick={refresh}>
              Refresh
            </Button>
            {operatorAccess.platformAdministrator ? (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={operatorAccess.checking}
                onClick={() => setAdding(true)}
              >
                Add repository
              </Button>
            ) : null}
          </Space>
        }
      />
      {process.env.NODE_ENV === "development" && (
        <Alert
          className="repositories-notice"
          showIcon
          type="info"
          title="Sample data"
          description="This preview uses sample repositories. Changes affect the preview only."
        />
      )}
      <Card className="repositories-panel">
        <div className="repositories-toolbar">
          <Input.Search
            className="repositories-search"
            aria-label="Search repositories"
            placeholder="Search owner or repository name"
            allowClear
            maxLength={512}
            value={searchInput}
            onChange={(event) => {
              setSearchInput(event.target.value);
              if (!event.target.value) {
                setSearch("");
                setPage(1);
              }
            }}
            onSearch={(value) => {
              setSearch(value.trim());
              setPage(1);
            }}
          />
          <span className="repositories-secondary" aria-live="polite">
            {listQuery.isFetching
              ? "Loading repositories…"
              : listQuery.isError
                ? "Repositories unavailable"
                : `${total.toLocaleString("en-US")} ${total === 1 ? "repository" : "repositories"}`}
          </span>
        </div>
        {listQuery.isError ? (
          <Alert
            showIcon
            type="error"
            title="Could not load repositories"
            description={errorMessage(listQuery.error)}
            action={<Button onClick={refresh}>Try again</Button>}
          />
        ) : listQuery.isPending ? (
          <div role="status" aria-label="Loading repositories">
            <Skeleton active paragraph={{ rows: 6 }} />
          </div>
        ) : items.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              search
                ? "No repositories match your search."
                : operatorAccess.platformAdministrator
                  ? "Add your first repository to start reviewing pull requests and issues."
                  : "No repository access. Ask a repository or platform administrator to share a repository with you."
            }
          >
            {search ? (
              <Button
                onClick={() => {
                  setSearch("");
                  setSearchInput("");
                  setPage(1);
                }}
              >
                Clear search
              </Button>
            ) : operatorAccess.platformAdministrator ? (
              <Button type="primary" onClick={() => setAdding(true)}>
                Add repository
              </Button>
            ) : null}
          </Empty>
        ) : (
          <ul className="repositories-list" aria-label="Managed repositories">
            {items.map((repository) => (
              <li className="repositories-item" key={repository.id}>
                <div className="repositories-item-main">
                  <div className="repositories-identity">
                    <GithubOutlined aria-hidden="true" className="repositories-github-icon" />
                    <div>
                      <a
                        className="repositories-name"
                        href={`/pull-requests?repositoryId=${encodeURIComponent(repository.id)}`}
                      >
                        {repository.fullName}
                      </a>
                      <div className="repositories-metadata">
                        <span>{repository.enabled ? "Enabled" : "Disabled"}</span>
                        <span>
                          Reviewer:{" "}
                          {repository.reviewerGithubLogin ??
                            (repository.reviewerGithubUserId
                              ? `ID ${repository.reviewerGithubUserId}`
                              : "Inherited default")}
                        </span>
                      </div>
                    </div>
                  </div>
                  <Connection repository={repository} />
                  <div className="repositories-item-actions">
                    <Button
                      onClick={() => setManaging(repository)}
                      aria-label={`Settings and access for ${repository.fullName}`}
                    >
                      Settings and access
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {!listQuery.isError && total > pageSize && (
          <div className="repositories-pagination">
            <Pagination
              current={page}
              pageSize={pageSize}
              total={total}
              showSizeChanger
              pageSizeOptions={[20, 50]}
              disabled={listQuery.isFetching}
              onChange={(nextPage, nextSize) => {
                setPage(nextSize === pageSize ? nextPage : 1);
                setPageSize(nextSize);
              }}
              showTotal={(count, range) => `${range[0]}–${range[1]} of ${count}`}
            />
          </div>
        )}
      </Card>
      {adding && (
        <OperatorAccessGate platformOnly>
          <AddRepositoryDrawer
            onClose={() => setAdding(false)}
            onCreated={(repository) => {
              setAdding(false);
              void messageApi.success(`${repository.fullName} added.`);
              void refresh();
            }}
          />
        </OperatorAccessGate>
      )}
      {managing ? (
        <Drawer
          open
          size={960}
          title={`Settings and access · ${managing.fullName}`}
          onClose={() => setManaging(null)}
        >
          <OperatorAccessGate repositoryId={managing.id}>
            <RepositoryManagement
              key={managing.id}
              repository={items.find((item) => item.id === managing.id) ?? managing}
              onUpdated={() => void refresh()}
            />
          </OperatorAccessGate>
        </Drawer>
      ) : null}
    </section>
  );
}
