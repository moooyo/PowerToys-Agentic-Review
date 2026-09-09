import type {
  OperatorPrincipal,
  OperatorRepositoryRole,
  RepositoryAccessAudit,
  RepositoryAccessChangeResponse,
  RepositoryAccessGrant,
} from "@agentic-review/contracts";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Grid,
  Input,
  Modal,
  Pagination,
  Select,
  Skeleton,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { access } from "@/services/access";
import {
  type AccessChangeDraft,
  type AccessNotice,
  accessChangeNotice,
  accessReceiptSummary,
  canManageRepositoryAccess,
  createAccessChangeRegistry,
  expectedAccessVersion,
  isAccessDenied,
  principalKey,
  repositoryAccessQueryKey,
  repositoryRoleDescriptions,
  repositoryRoleLabels,
  samePrincipal,
} from "./helpers";
import "./index.css";

export interface RepositoryAccessDrawerProps {
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly canManage: boolean;
  readonly platformAdministrator: boolean;
  readonly currentPrincipal: OperatorPrincipal;
  readonly onChanged?: () => void;
}

interface AccessEditor {
  readonly grant: RepositoryAccessGrant | null;
  readonly action: "grant" | "edit" | "revoke";
}

const pageSize = 20;
const runtimeAccessExplanation =
  "Platform administrator access is configured by the server runtime and is not listed as a repository grant. Changing or revoking a repository role does not remove platform administrator access.";

function Identity({ principal }: { readonly principal: OperatorPrincipal }) {
  return (
    <div className="repository-access-identity">
      <Typography.Text>
        <Typography.Text type="secondary">Subject: </Typography.Text>
        <code>{principal.subject}</code>
      </Typography.Text>
      <Typography.Text type="secondary">
        Issuer: <code>{principal.issuer}</code>
      </Typography.Text>
    </div>
  );
}

function Role({ role }: { readonly role: OperatorRepositoryRole | null }) {
  return (
    <Tag color={role === "admin" ? "processing" : "default"}>
      {role === null ? "Revoked" : repositoryRoleLabels[role]}
    </Tag>
  );
}

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString();
}

function ChangeEditor({
  editor,
  repositoryId,
  repositoryName,
  currentPrincipal,
  platformAdministrator,
  saving,
  allowed,
  onClose,
  onReload,
  onSubmit,
}: {
  readonly editor: AccessEditor;
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly currentPrincipal: OperatorPrincipal;
  readonly platformAdministrator: boolean;
  readonly saving: boolean;
  readonly allowed: boolean;
  readonly onClose: () => void;
  readonly onReload: () => void;
  readonly onSubmit: (draft: AccessChangeDraft) => Promise<void>;
}) {
  const [form] = Form.useForm<{
    issuer: string;
    subject: string;
    role: OperatorRepositoryRole;
    reason: string;
  }>();
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState<AccessNotice | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const revoke = editor.action === "revoke";
  const ownGrant = editor.grant && samePrincipal(editor.grant.principal, currentPrincipal);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = async () => {
    if (
      !allowed ||
      saving ||
      pending.current ||
      (revoke && !confirmed) ||
      notice?.kind === "conflict"
    ) {
      return;
    }
    pending.current = true;
    try {
      const values = await form.validateFields();
      if (!mounted.current || !allowed) return;
      setNotice(null);
      await onSubmit({
        repositoryId,
        principal: editor.grant?.principal ?? { issuer: values.issuer, subject: values.subject },
        role: revoke ? null : values.role,
        expectedVersion: expectedAccessVersion(editor.grant),
        reason: values.reason,
      });
    } catch (failure) {
      if (
        mounted.current &&
        !(typeof failure === "object" && failure !== null && "errorFields" in failure)
      ) {
        setNotice(accessChangeNotice(failure));
      }
    } finally {
      pending.current = false;
    }
  };

  return (
    <Modal
      open
      title={
        revoke
          ? "Revoke repository access"
          : editor.grant
            ? "Change repository role"
            : "Grant repository access"
      }
      width={620}
      onCancel={onClose}
      closable={!saving}
      keyboard={!saving}
      mask={{ closable: !saving }}
      footer={
        <Space wrap>
          <Button disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          {notice?.kind === "conflict" ? (
            <Button type="primary" onClick={onReload}>
              Close and reload members
            </Button>
          ) : (
            <Button
              type="primary"
              danger={revoke}
              loading={saving}
              disabled={!allowed || (revoke && !confirmed)}
              onClick={() => void submit()}
            >
              {revoke ? "Revoke access" : "Save access"}
            </Button>
          )}
        </Space>
      }
      destroyOnHidden
    >
      <Typography.Paragraph strong>{repositoryName}</Typography.Paragraph>
      <Typography.Paragraph type="secondary">
        Use the exact, case-sensitive issuer and subject from the identity provider. Email addresses
        and display names do not identify an operator. Values are sent exactly as entered.
      </Typography.Paragraph>
      {editor.grant && (
        <Descriptions
          size="small"
          column={2}
          items={[
            {
              key: "role",
              label: "Current repository role",
              children: <Role role={editor.grant.role} />,
            },
            { key: "version", label: "Record version", children: editor.grant.version },
          ]}
        />
      )}
      <Form
        className="repository-access-form"
        form={form}
        layout="vertical"
        disabled={saving || !allowed}
        initialValues={{
          issuer: editor.grant?.principal.issuer ?? "",
          subject: editor.grant?.principal.subject ?? "",
          role: editor.grant?.role ?? "viewer",
          reason: "",
        }}
        onValuesChange={() => {
          setConfirmed(false);
          if (notice?.kind !== "conflict") setNotice(null);
        }}
      >
        <Form.Item
          name="issuer"
          label="Issuer"
          rules={[{ required: true, message: "Enter the exact issuer." }, { max: 2_048 }]}
        >
          <Input
            aria-label="Issuer"
            readOnly={Boolean(editor.grant)}
            maxLength={2_048}
            autoComplete="off"
            spellCheck={false}
          />
        </Form.Item>
        <Form.Item
          name="subject"
          label="Subject"
          rules={[{ required: true, message: "Enter the exact subject." }, { max: 512 }]}
        >
          <Input
            aria-label="Subject"
            readOnly={Boolean(editor.grant)}
            maxLength={512}
            autoComplete="off"
            spellCheck={false}
          />
        </Form.Item>
        {!revoke && (
          <Form.Item name="role" label="Repository role" rules={[{ required: true }]}>
            <Select
              aria-label="Repository role"
              options={(Object.keys(repositoryRoleLabels) as OperatorRepositoryRole[]).map(
                (role) => ({
                  value: role,
                  label: `${repositoryRoleLabels[role]} — ${repositoryRoleDescriptions[role]}`,
                }),
              )}
            />
          </Form.Item>
        )}
        <Form.Item
          name="reason"
          label="Reason"
          rules={[
            { required: true, whitespace: true, message: "Enter a reason for this change." },
            { max: 2_048 },
          ]}
          extra="The audit history records this reason with your authenticated issuer and subject."
        >
          <Input.TextArea aria-label="Reason" rows={3} maxLength={2_048} showCount />
        </Form.Item>
      </Form>
      {!editor.grant && (
        <Typography.Paragraph type="secondary">
          New identities use record version 0. If this identity already has a record, including
          revoked access, edit that record from Members instead.
        </Typography.Paragraph>
      )}
      {revoke && (
        <Alert
          type="warning"
          showIcon
          title="Confirm the exact identity before revoking"
          description={
            <div className="repository-access-stack">
              {editor.grant && <Identity principal={editor.grant.principal} />}
              <span>
                The explicit repository role in {repositoryName} will be revoked. Its record and
                version will remain in the audit history.
              </span>
            </div>
          }
        />
      )}
      {ownGrant && !platformAdministrator && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
          This is your own repository grant. Removing Admin may prevent you from managing repository
          access.
        </Typography.Paragraph>
      )}
      <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
        {runtimeAccessExplanation}
      </Typography.Paragraph>
      {revoke && (
        <Checkbox
          className="repository-access-confirmation"
          checked={confirmed}
          disabled={saving || !allowed}
          onChange={(event) => setConfirmed(event.target.checked)}
        >
          I confirm revoking the repository role for the exact identity shown above in{" "}
          {repositoryName}.
        </Checkbox>
      )}
      {notice && (
        <Alert
          style={{ marginTop: 16 }}
          showIcon
          type="error"
          title={notice.title}
          description={notice.description}
        />
      )}
      {!allowed && (
        <Alert
          style={{ marginTop: 16 }}
          type="warning"
          showIcon
          title="Your permission must be refreshed before changing access."
        />
      )}
    </Modal>
  );
}

function AccessSession({
  repositoryId,
  repositoryName,
  currentPrincipal,
  platformAdministrator,
  onChanged,
  onBusyChange,
}: Omit<RepositoryAccessDrawerProps, "open" | "onClose" | "canManage"> & {
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [memberPage, setMemberPage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);
  const [editor, setEditor] = useState<AccessEditor | null>(null);
  const [receipt, setReceipt] = useState<RepositoryAccessChangeResponse | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  const permission = useRef(false);
  const permissionLossReported = useRef(false);
  const intents = useRef(createAccessChangeRegistry());
  const baseKey = repositoryAccessQueryKey(access.mode, repositoryId, currentPrincipal);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      permission.current = false;
    };
  }, []);

  const recordFailure = (failure: unknown): never => {
    if (mounted.current && isAccessDenied(failure)) {
      permission.current = false;
      setBlocked(true);
      if (!permissionLossReported.current) {
        permissionLossReported.current = true;
        onChanged?.();
      }
    }
    throw failure;
  };
  const contextQuery = useQuery({
    queryKey: [...baseKey, "context"],
    queryFn: () => access.context(repositoryId).catch(recordFailure),
    retry: false,
    staleTime: 30_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const authorityReady =
    contextQuery.isSuccess &&
    !contextQuery.isFetching &&
    canManageRepositoryAccess(contextQuery.data, repositoryId, currentPrincipal);
  const allowed = authorityReady && !blocked && !refreshing;
  permission.current = allowed;

  const membersQuery = useQuery({
    queryKey: [...baseKey, "members", memberPage],
    queryFn: () => access.list(repositoryId, { page: memberPage, pageSize }).catch(recordFailure),
    enabled: allowed,
    retry: false,
    staleTime: 30_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const auditQuery = useQuery({
    queryKey: [...baseKey, "audit", auditPage],
    queryFn: () => access.history(repositoryId, { page: auditPage, pageSize }).catch(recordFailure),
    enabled: allowed,
    retry: false,
    staleTime: 30_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const membersReady = allowed && membersQuery.isSuccess && !membersQuery.isFetching;
  const serverPlatformAdministrator =
    contextQuery.data?.platformAdministrator ?? platformAdministrator;

  const refresh = async () => {
    if (!mounted.current || refreshing || pending.current) return;
    setRefreshing(true);
    permission.current = false;
    try {
      await queryClient.invalidateQueries({ queryKey: baseKey, refetchType: "none" });
      const context = await contextQuery.refetch();
      if (!mounted.current) return;
      if (
        !context.isSuccess ||
        !canManageRepositoryAccess(context.data, repositoryId, currentPrincipal)
      ) {
        setBlocked(true);
        return;
      }
      setBlocked(false);
      permissionLossReported.current = false;
      await Promise.allSettled([membersQuery.refetch(), auditQuery.refetch()]);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  };

  const submit = async (draft: AccessChangeDraft) => {
    if (pending.current || !permission.current || draft.repositoryId !== repositoryId) {
      throw new Error("Refresh repository access before submitting this change.");
    }
    const request = intents.current.prepare(draft);
    pending.current = true;
    setSaving(true);
    onBusyChange(true);
    try {
      const accepted = await access.change(repositoryId, request).catch(recordFailure);
      intents.current.accepted(repositoryId, request);
      await queryClient.invalidateQueries({ queryKey: baseKey, refetchType: "none" });
      if (!mounted.current) return;
      setReceipt(accepted);
      setEditor(null);
      pending.current = false;
      await refresh();
      if (mounted.current) onChanged?.();
    } finally {
      pending.current = false;
      if (mounted.current) {
        setSaving(false);
        onBusyChange(false);
      }
    }
  };

  return (
    <div className="repository-access-stack">
      <Descriptions
        size="small"
        column={1}
        items={[
          { key: "repository", label: "Repository", children: repositoryName },
          {
            key: "principal",
            label: "Current operator",
            children: <Identity principal={currentPrincipal} />,
          },
          {
            key: "authority",
            label: "Access source",
            children: contextQuery.isFetching
              ? "Checking access…"
              : contextQuery.isSuccess
                ? contextQuery.data.repository?.source === "platform"
                  ? "Platform administrator (server runtime)"
                  : contextQuery.data.repository
                    ? "Repository role"
                    : "No repository role"
                : "Unavailable",
          },
        ]}
      />
      {access.mode === "sample" && (
        <Alert
          type="info"
          showIcon
          title="Sample access management"
          description="This preview uses local simulated members and audit records. Changes affect sample data only and are not sent to the production server."
        />
      )}
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {runtimeAccessExplanation}
      </Typography.Paragraph>
      {receipt && (
        <Alert
          showIcon
          type="success"
          title={receipt.replayed ? "Existing change receipt received" : "Access change recorded"}
          description={
            <div className="repository-access-stack">
              <Identity principal={receipt.change.principal} />
              <span>{accessReceiptSummary(receipt)}</span>
            </div>
          }
        />
      )}
      <div className="repository-access-toolbar">
        <Typography.Text strong>Repository access</Typography.Text>
        <Space wrap>
          <Button
            icon={<ReloadOutlined />}
            loading={refreshing || contextQuery.isFetching}
            disabled={saving}
            onClick={() => void refresh()}
          >
            Refresh access
          </Button>
          {allowed && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!membersReady || saving}
              onClick={() => setEditor({ grant: null, action: "grant" })}
            >
              Grant access
            </Button>
          )}
        </Space>
      </div>
      {contextQuery.isError ? (
        <Alert
          type="error"
          showIcon
          title="Repository permissions could not be verified"
          description={accessChangeNotice(contextQuery.error).description}
        />
      ) : contextQuery.isFetching || refreshing ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : !allowed ? (
        <Alert
          type="warning"
          showIcon
          title="Repository access management is restricted"
          description="Members and audit history are available only to an operator with Manage access permission for this repository. Refresh access to check your current permissions."
        />
      ) : (
        <Tabs
          items={[
            {
              key: "members",
              label: "Members",
              children: membersQuery.isError ? (
                <Alert
                  type="error"
                  showIcon
                  title="Members could not be loaded"
                  description={accessChangeNotice(membersQuery.error).description}
                />
              ) : membersQuery.isPending ? (
                <Skeleton active paragraph={{ rows: 4 }} />
              ) : (
                <>
                  <Typography.Paragraph type="secondary">
                    Revoked entries remain visible so future changes use the current record version.
                    These are explicit repository grants, not the list of platform administrators.
                  </Typography.Paragraph>
                  <Table<RepositoryAccessGrant>
                    className="repository-access-table"
                    size="small"
                    rowKey={(grant) => principalKey(grant.principal)}
                    loading={membersQuery.isFetching}
                    dataSource={membersQuery.data?.items ?? []}
                    pagination={false}
                    scroll={{ x: 640 }}
                    locale={{
                      emptyText: (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description="No explicit repository access records."
                        />
                      ),
                    }}
                    columns={[
                      {
                        title: "Identity",
                        key: "identity",
                        width: 320,
                        render: (_, grant) => (
                          <Space orientation="vertical" size={4}>
                            <Identity principal={grant.principal} />
                            {samePrincipal(grant.principal, currentPrincipal) && <Tag>You</Tag>}
                          </Space>
                        ),
                      },
                      {
                        title: "Role",
                        key: "role",
                        width: 140,
                        render: (_, grant) => (
                          <Space orientation="vertical" size={4}>
                            <Role role={grant.role} />
                            <Typography.Text type="secondary">
                              Version {grant.version}
                            </Typography.Text>
                          </Space>
                        ),
                      },
                      {
                        title: "Actions",
                        key: "actions",
                        width: 180,
                        render: (_, grant) => (
                          <Space wrap>
                            <Button
                              size="small"
                              disabled={!membersReady || saving}
                              onClick={() => setEditor({ grant, action: "edit" })}
                            >
                              {grant.role === null ? "Restore access" : "Change role"}
                            </Button>
                            {grant.role !== null && (
                              <Button
                                size="small"
                                danger
                                disabled={!membersReady || saving}
                                onClick={() => setEditor({ grant, action: "revoke" })}
                              >
                                Revoke
                              </Button>
                            )}
                          </Space>
                        ),
                      },
                    ]}
                    expandable={{
                      expandedRowRender: (grant) => (
                        <Descriptions
                          size="small"
                          column={1}
                          items={[
                            {
                              key: "created",
                              label: "Created",
                              children: timestamp(grant.createdAt),
                            },
                            {
                              key: "updated",
                              label: "Last updated",
                              children: timestamp(grant.updatedAt),
                            },
                            {
                              key: "actor",
                              label: "Updated by",
                              children: <Identity principal={grant.updatedBy} />,
                            },
                          ]}
                        />
                      ),
                    }}
                  />
                  <div className="repository-access-pagination">
                    <Pagination
                      current={memberPage}
                      pageSize={pageSize}
                      total={membersQuery.data?.total ?? 0}
                      showSizeChanger={false}
                      hideOnSinglePage
                      showTotal={(total) => `${total} access records`}
                      onChange={setMemberPage}
                      disabled={saving || membersQuery.isFetching}
                    />
                  </div>
                </>
              ),
            },
            {
              key: "audit",
              label: "Audit history",
              children: auditQuery.isError ? (
                <Alert
                  type="error"
                  showIcon
                  title="Audit history could not be loaded"
                  description={accessChangeNotice(auditQuery.error).description}
                />
              ) : auditQuery.isPending ? (
                <Skeleton active paragraph={{ rows: 4 }} />
              ) : (
                <>
                  <Typography.Paragraph type="secondary">
                    Each entry records the authenticated actor and accepted change at that time.
                    Earlier entries do not describe current access.
                  </Typography.Paragraph>
                  <Table<RepositoryAccessAudit>
                    className="repository-access-table"
                    size="small"
                    rowKey="id"
                    loading={auditQuery.isFetching}
                    dataSource={auditQuery.data?.items ?? []}
                    pagination={false}
                    scroll={{ x: 640 }}
                    locale={{
                      emptyText: (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description="No access changes recorded."
                        />
                      ),
                    }}
                    columns={[
                      {
                        title: "Identity",
                        key: "identity",
                        width: 280,
                        render: (_, change) => <Identity principal={change.principal} />,
                      },
                      {
                        title: "Recorded change",
                        key: "change",
                        width: 200,
                        render: (_, change) => (
                          <Space orientation="vertical" size={4}>
                            <span>
                              {change.previousRole === null
                                ? "No repository role"
                                : repositoryRoleLabels[change.previousRole]}{" "}
                              →{" "}
                              {change.role === null ? "Revoked" : repositoryRoleLabels[change.role]}
                            </span>
                            <Typography.Text type="secondary">
                              Version {change.previousVersion} → {change.version}
                            </Typography.Text>
                          </Space>
                        ),
                      },
                      {
                        title: "Recorded",
                        key: "created",
                        width: 160,
                        render: (_, change) => timestamp(change.createdAt),
                      },
                    ]}
                    expandable={{
                      expandedRowRender: (change) => (
                        <Descriptions
                          size="small"
                          column={1}
                          items={[
                            {
                              key: "actor",
                              label: "Changed by",
                              children: <Identity principal={change.actor} />,
                            },
                            {
                              key: "reason",
                              label: "Reason",
                              children: (
                                <span className="repository-access-details">{change.reason}</span>
                              ),
                            },
                            {
                              key: "change",
                              label: "Change ID",
                              children: (
                                <Typography.Text code copyable>
                                  {change.changeId}
                                </Typography.Text>
                              ),
                            },
                          ]}
                        />
                      ),
                    }}
                  />
                  <div className="repository-access-pagination">
                    <Pagination
                      current={auditPage}
                      pageSize={pageSize}
                      total={auditQuery.data?.total ?? 0}
                      showSizeChanger={false}
                      hideOnSinglePage
                      showTotal={(total) => `${total} recorded changes`}
                      onChange={setAuditPage}
                      disabled={saving || auditQuery.isFetching}
                    />
                  </div>
                </>
              ),
            },
          ]}
        />
      )}
      {editor && (
        <ChangeEditor
          editor={editor}
          repositoryId={repositoryId}
          repositoryName={repositoryName}
          currentPrincipal={currentPrincipal}
          platformAdministrator={serverPlatformAdministrator}
          saving={saving}
          allowed={allowed}
          onClose={() => setEditor(null)}
          onReload={() => {
            setEditor(null);
            void refresh();
          }}
          onSubmit={submit}
        />
      )}
    </div>
  );
}

export function RepositoryAccessDrawer(props: RepositoryAccessDrawerProps) {
  const screens = Grid.useBreakpoint();
  const [busy, setBusy] = useState(false);
  const sessionKey = JSON.stringify([
    props.repositoryId,
    props.currentPrincipal.issuer,
    props.currentPrincipal.subject,
  ]);
  const busyScope = useRef(sessionKey);
  useEffect(() => {
    if (!props.open || !props.canManage || busyScope.current !== sessionKey) {
      busyScope.current = sessionKey;
      setBusy(false);
    }
  }, [props.open, props.canManage, sessionKey]);
  return (
    <Drawer
      rootClassName="repository-access-drawer"
      title="Repository access"
      open={props.open}
      size={screens.lg ? 860 : "100%"}
      onClose={props.onClose}
      closable={!busy}
      keyboard={!busy}
      mask={{ closable: !busy }}
      destroyOnHidden
    >
      {props.open &&
        (props.canManage ? (
          <AccessSession
            key={sessionKey}
            repositoryId={props.repositoryId}
            repositoryName={props.repositoryName}
            currentPrincipal={props.currentPrincipal}
            platformAdministrator={props.platformAdministrator}
            onChanged={props.onChanged}
            onBusyChange={setBusy}
          />
        ) : (
          <div className="repository-access-stack">
            <Typography.Text strong>{props.repositoryName}</Typography.Text>
            <Alert
              type="warning"
              showIcon
              title="Repository access management is restricted"
              description="Your verified permissions do not include Manage access for this repository. Members and audit history have not been requested. Ask a repository or platform administrator to review your access."
            />
            <Typography.Paragraph type="secondary">{runtimeAccessExplanation}</Typography.Paragraph>
          </div>
        ))}
    </Drawer>
  );
}
