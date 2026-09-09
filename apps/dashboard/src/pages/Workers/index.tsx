import {
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined,
} from "@ant-design/icons";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import { ProTable } from "@ant-design/pro-components";
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  message,
  Progress,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useMemo, useRef, useState } from "react";
import { OperatorAccessGate } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import { StatusTag } from "@/components/StatusTag";
import { reviewControl, type WorkerCredentialSecret } from "@/services/review-control";
import { asFilterValue, asSearchValue } from "@/utils/table";
import { CredentialRevealModal } from "./CredentialRevealModal";
import {
  isSafeWorkerDisplayName,
  runSingleFlight,
  type SynchronousGate,
  tryAcquireGate,
  workerMutationErrorText,
} from "./credential-mutation";
import {
  createWorkerInventorySnapshotCache,
  DEFAULT_WORKER_INVENTORY_PAGE_SIZE,
  filterWorkerInventory,
  isCanonicalWorkerNodeId,
  MAX_WORKER_INVENTORY_PAGE_SIZE,
  mergeWorkerInventory,
  paginateWorkerInventory,
  type WorkerInventoryAuthState,
  type WorkerInventoryRow,
  type WorkerInventoryRuntimeState,
  type WorkerInventorySnapshotCache,
} from "./worker-inventory";
import "./index.css";

type MutationKey = "create" | `rotate:${string}` | `revoke:${string}`;

interface CreateWorkerFields {
  displayName: string;
}

interface RevealedCredential {
  operation: "created" | "rotated";
  secret: WorkerCredentialSecret;
}

interface WorkerListParams {
  search?: string;
  authState?: WorkerInventoryAuthState;
  runtimeState?: WorkerInventoryRuntimeState;
}

export default function WorkersPage() {
  return (
    <OperatorAccessGate platformOnly>
      <WorkersContent />
    </OperatorAccessGate>
  );
}

function WorkersContent() {
  const actionRef = useRef<ActionType>(null);
  const confirmationGateRef = useRef<SynchronousGate>({ active: false });
  const credentialMutationGateRef = useRef<SynchronousGate>({ active: false });
  const inventoryCacheRef = useRef<WorkerInventorySnapshotCache | null>(null);
  if (inventoryCacheRef.current === null) {
    inventoryCacheRef.current = createWorkerInventorySnapshotCache(async () => {
      const [credentials, workers] = await Promise.all([
        reviewControl.listWorkerCredentials(),
        reviewControl.listAllWorkers(),
      ]);
      return mergeWorkerInventory(credentials.items, workers.items);
    });
  }
  const inventoryCache = inventoryCacheRef.current;
  const [createForm] = Form.useForm<CreateWorkerFields>();
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [accessFilter, setAccessFilter] = useState<WorkerInventoryAuthState | "all">("all");
  const [runtimeFilter, setRuntimeFilter] = useState<WorkerInventoryRuntimeState | "all">("all");
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [mutationKey, setMutationKey] = useState<MutationKey | null>(null);
  const [revealedCredential, setRevealedCredential] = useState<RevealedCredential | null>(null);
  const [messageApi, messageContext] = message.useMessage();
  const [modalApi, modalContext] = Modal.useModal();
  const tableParams = useMemo<WorkerListParams>(
    () => ({
      search: asSearchValue(search),
      authState: accessFilter === "all" ? undefined : accessFilter,
      runtimeState: runtimeFilter === "all" ? undefined : runtimeFilter,
    }),
    [search, accessFilter, runtimeFilter],
  );

  const reloadInventory = () => {
    inventoryCache.invalidate();
    void actionRef.current?.reload();
  };

  const createWorker = async ({ displayName }: CreateWorkerFields) => {
    await runSingleFlight(credentialMutationGateRef.current, async () => {
      setMutationKey("create");
      try {
        const secret = await reviewControl.createWorkerCredential(displayName.trim());
        setCreateOpen(false);
        createForm.resetFields();
        setRevealedCredential({ operation: "created", secret });
        reloadInventory();
      } catch (error) {
        messageApi.error(
          workerMutationErrorText(error, "The worker credential could not be created."),
        );
      } finally {
        setMutationKey(null);
      }
    });
  };

  const confirmRotate = (row: WorkerInventoryRow) => {
    if (row.credential === undefined) {
      return;
    }
    const expectedUpdatedAt = row.credential.updatedAt;
    const releaseConfirmation = tryAcquireGate(confirmationGateRef.current);
    if (releaseConfirmation === undefined) {
      return;
    }
    try {
      modalApi.confirm({
        afterClose: releaseConfirmation,
        autoFocusButton: "cancel",
        content: (
          <Space orientation="vertical" size={6}>
            <Typography.Text>{row.displayName}</Typography.Text>
            <Typography.Text className="mono" type="secondary">
              {row.workerNodeId}
            </Typography.Text>
            <Typography.Text type="warning">
              The current token stops working as soon as rotation succeeds.
            </Typography.Text>
          </Space>
        ),
        okText: "Rotate token",
        onOk: async () => {
          await runSingleFlight(credentialMutationGateRef.current, async () => {
            const key: MutationKey = `rotate:${row.workerNodeId}`;
            setMutationKey(key);
            try {
              const secret = await reviewControl.rotateWorkerToken(
                row.workerNodeId,
                expectedUpdatedAt,
              );
              setRevealedCredential({ operation: "rotated", secret });
              reloadInventory();
            } catch (error) {
              messageApi.error(
                workerMutationErrorText(error, "The worker token could not be rotated."),
              );
            } finally {
              setMutationKey(null);
            }
          });
        },
        title: "Rotate this worker token?",
      });
    } catch {
      releaseConfirmation();
    }
  };

  const confirmRevoke = (row: WorkerInventoryRow) => {
    const releaseConfirmation = tryAcquireGate(confirmationGateRef.current);
    if (releaseConfirmation === undefined) {
      return;
    }
    try {
      modalApi.confirm({
        afterClose: releaseConfirmation,
        autoFocusButton: "cancel",
        content: (
          <Space orientation="vertical" size={6}>
            <Typography.Text>{row.displayName}</Typography.Text>
            <Typography.Text className="mono" type="secondary">
              {row.workerNodeId}
            </Typography.Text>
            <Typography.Text type="danger">
              The worker will be denied on its next authenticated request. Revocation cannot be
              reversed.
            </Typography.Text>
          </Space>
        ),
        okButtonProps: { danger: true },
        okText: "Revoke access",
        onOk: async () => {
          await runSingleFlight(credentialMutationGateRef.current, async () => {
            const key: MutationKey = `revoke:${row.workerNodeId}`;
            setMutationKey(key);
            try {
              await reviewControl.revokeWorkerToken(row.workerNodeId);
              messageApi.success("Worker access revoked.");
              reloadInventory();
            } catch (error) {
              messageApi.error(
                workerMutationErrorText(error, "Worker access could not be revoked."),
              );
            } finally {
              setMutationKey(null);
            }
          });
        },
        title: "Revoke this worker?",
      });
    } catch {
      releaseConfirmation();
    }
  };

  const columns: ProColumns<WorkerInventoryRow>[] = [
    {
      title: "Worker",
      dataIndex: "workerNodeId",
      width: 280,
      search: false,
      render: (_, row) => (
        <div className="worker-inventory__identity">
          <div className="worker-inventory__name">
            <Typography.Text strong>{row.displayName}</Typography.Text>
            <Tooltip title={row.workerNodeId}>
              <Typography.Text className="worker-inventory__node-id mono">
                {row.workerNodeId}
              </Typography.Text>
            </Tooltip>
            {row.runtime === undefined ? null : (
              <Typography.Text className="worker-inventory__instance-id mono">
                {row.runtime.instanceId}
              </Typography.Text>
            )}
          </div>
        </div>
      ),
    },
    {
      title: "Access",
      dataIndex: "authState",
      width: 112,
      valueEnum: {
        pending: { text: "Pending" },
        active: { text: "Active" },
        revoked: { text: "Revoked" },
        unknown: { text: "Unknown" },
      },
      render: (_, row) => <StatusTag status={row.authState} />,
    },
    {
      title: "Runtime",
      dataIndex: "runtimeState",
      width: 126,
      valueEnum: {
        online: { text: "Online" },
        draining: { text: "Draining" },
        offline: { text: "Offline" },
        disabled: { text: "Disabled" },
        not_connected: { text: "Not connected" },
      },
      render: (_, row) => <StatusTag status={row.runtimeState} />,
    },
    {
      title: "Location",
      dataIndex: ["runtime", "location"],
      key: "location",
      width: 120,
      search: false,
      renderText: (value) => value ?? "—",
    },
    {
      title: "Slots",
      dataIndex: ["runtime", "activeSlots"],
      key: "slots",
      width: 150,
      search: false,
      render: (_, row) =>
        row.runtime === undefined ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Progress
            format={() => `${row.runtime?.activeSlots}/${row.runtime?.maxSlots}`}
            percent={Math.round((row.runtime.activeSlots / row.runtime.maxSlots) * 100)}
            size="small"
            status="normal"
            strokeColor="var(--app-accent)"
          />
        ),
    },
    {
      title: "Capabilities",
      dataIndex: ["runtime", "capabilities"],
      key: "capabilities",
      width: 240,
      search: false,
      render: (_, row) =>
        row.runtime === undefined ? (
          <Typography.Text type="secondary">Awaiting registration</Typography.Text>
        ) : (
          <Space size={[4, 4]} wrap>
            {row.runtime.capabilities.map((capability) => (
              <Tag key={capability}>{capability}</Tag>
            ))}
          </Space>
        ),
    },
    {
      title: "Current jobs",
      dataIndex: ["runtime", "currentJobs"],
      key: "currentJobs",
      width: 180,
      search: false,
      render: (_, row) =>
        row.runtime === undefined || row.runtime.currentJobs.length === 0 ? (
          <Typography.Text type="secondary">
            {row.runtime === undefined ? "—" : "Idle"}
          </Typography.Text>
        ) : (
          <Space orientation="vertical" size={0}>
            {row.runtime.currentJobs.map((job) => (
              <Typography.Text className="mono" key={job}>
                {job}
              </Typography.Text>
            ))}
          </Space>
        ),
    },
    {
      title: "Disk free",
      dataIndex: ["runtime", "diskFreeGb"],
      key: "diskFreeGb",
      width: 104,
      search: false,
      renderText: (value) => (value === undefined ? "—" : `${value} GB`),
    },
    {
      title: "Heartbeat",
      dataIndex: ["runtime", "lastHeartbeatAt"],
      key: "lastHeartbeatAt",
      valueType: "dateTime",
      width: 168,
      search: false,
      renderText: (value) => value ?? "—",
    },
    {
      title: "Credential updated",
      dataIndex: ["credential", "updatedAt"],
      key: "credentialUpdatedAt",
      valueType: "dateTime",
      width: 168,
      search: false,
      renderText: (value) => value ?? "—",
    },
    {
      title: "Version",
      dataIndex: ["runtime", "version"],
      key: "version",
      width: 92,
      search: false,
      renderText: (value) => value ?? "—",
    },
    {
      title: "Actions",
      key: "actions",
      valueType: "option",
      fixed: "right",
      width: 96,
      render: (_, row) => {
        const legacyNodeId = !isCanonicalWorkerNodeId(row.workerNodeId);
        const unavailable =
          row.credential === undefined || row.authState === "revoked" || legacyNodeId;
        const unavailableReason = legacyNodeId
          ? "Legacy worker node IDs cannot use credential mutations"
          : "No rotatable credential is available";
        return [
          <Tooltip key="rotate" title={unavailable ? unavailableReason : "Rotate token"}>
            <Button
              aria-label={`Rotate token for ${row.workerNodeId}`}
              disabled={mutationKey !== null || unavailable}
              icon={<KeyOutlined />}
              loading={mutationKey === `rotate:${row.workerNodeId}`}
              onClick={() => confirmRotate(row)}
              type="text"
            />
          </Tooltip>,
          <Tooltip
            key="revoke"
            title={
              unavailable
                ? legacyNodeId
                  ? unavailableReason
                  : "Worker access is already unavailable"
                : "Revoke access"
            }
          >
            <Button
              aria-label={`Revoke access for ${row.workerNodeId}`}
              danger
              disabled={mutationKey !== null || unavailable}
              icon={<StopOutlined />}
              loading={mutationKey === `revoke:${row.workerNodeId}`}
              onClick={() => confirmRevoke(row)}
              type="text"
            />
          </Tooltip>,
        ];
      },
    },
  ];

  return (
    <section aria-labelledby="workers-page-title" className="workers-page">
      {messageContext}
      {modalContext}

      <PageHeader
        eyebrow="Operations"
        title="Workers"
        titleId="workers-page-title"
        description="Manage workers, capacity, and access."
        actions={
          <Space wrap size={8}>
            <Button icon={<ReloadOutlined />} loading={inventoryLoading} onClick={reloadInventory}>
              Refresh
            </Button>
            <Button
              disabled={mutationKey !== null}
              icon={<PlusOutlined />}
              onClick={() => setCreateOpen(true)}
              type="primary"
            >
              Register worker
            </Button>
          </Space>
        }
      />

      <Card className="workers-panel">
        {inventoryError !== null && (
          <Alert
            className="workers-error"
            description={inventoryError}
            title="Worker inventory could not be refreshed"
            showIcon
            type="error"
          />
        )}
        <ProTable<WorkerInventoryRow, WorkerListParams>
          actionRef={actionRef}
          cardProps={false}
          className="workers-table"
          columns={columns}
          columnsState={{
            defaultValue: {
              capabilities: { show: false },
              credentialUpdatedAt: { show: false },
              diskFreeGb: { show: false },
              lastHeartbeatAt: { show: false },
              version: { show: false },
            },
            persistenceKey: "agentic-review:workers:columns:v1",
            persistenceType: "localStorage",
          }}
          debounceTime={180}
          headerTitle={false}
          onLoadingChange={(loading) => {
            setInventoryLoading(
              loading === true || (typeof loading === "object" && loading.spinning !== false),
            );
          }}
          onRequestError={(error) => {
            setInventoryError(
              workerMutationErrorText(error, "Refresh the worker list to try again."),
            );
          }}
          options={{ density: false, fullScreen: false, reload: false, setting: true }}
          pagination={{
            defaultPageSize: DEFAULT_WORKER_INVENTORY_PAGE_SIZE,
            hideOnSinglePage: true,
            pageSizeOptions: [50, 100, MAX_WORKER_INVENTORY_PAGE_SIZE],
            showSizeChanger: true,
            showTotal: (total) => `${total} ${total === 1 ? "worker" : "workers"}`,
          }}
          params={tableParams}
          request={async (params) => {
            setInventoryError(null);
            const rows = filterWorkerInventory(await inventoryCache.load(), {
              search: asSearchValue(params.search),
              authState: asFilterValue(params.authState),
              runtimeState: asFilterValue(params.runtimeState),
            });
            const page = paginateWorkerInventory(rows, params.current, params.pageSize);
            return { data: page.items, success: true, total: page.total };
          }}
          rowKey="workerNodeId"
          scroll={{ x: true }}
          search={false}
          size="middle"
          toolbar={{
            search: (
              <div className="workers-filters">
                <Input
                  allowClear
                  aria-label="Search workers"
                  className="workers-search"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Name, node, instance, or location"
                  prefix={<SearchOutlined aria-hidden />}
                  value={search}
                />
                <div className="workers-filter">
                  <label htmlFor="workers-access-filter">Access</label>
                  <Select<WorkerInventoryAuthState | "all">
                    aria-label="Filter workers by access"
                    className="workers-access-filter"
                    id="workers-access-filter"
                    onChange={setAccessFilter}
                    options={[
                      { value: "all", label: "All access" },
                      { value: "pending", label: "Pending" },
                      { value: "active", label: "Active" },
                      { value: "revoked", label: "Revoked" },
                      { value: "unknown", label: "Unknown" },
                    ]}
                    value={accessFilter}
                  />
                </div>
                <div className="workers-filter">
                  <label htmlFor="workers-runtime-filter">Runtime</label>
                  <Select<WorkerInventoryRuntimeState | "all">
                    aria-label="Filter workers by runtime"
                    className="workers-runtime-filter"
                    id="workers-runtime-filter"
                    onChange={setRuntimeFilter}
                    options={[
                      { value: "all", label: "All runtime" },
                      { value: "online", label: "Online" },
                      { value: "draining", label: "Draining" },
                      { value: "offline", label: "Offline" },
                      { value: "disabled", label: "Disabled" },
                      { value: "not_connected", label: "Not connected" },
                    ]}
                    value={runtimeFilter}
                  />
                </div>
              </div>
            ),
          }}
        />
      </Card>

      <Modal
        cancelButtonProps={{ disabled: mutationKey === "create" }}
        confirmLoading={mutationKey === "create"}
        className="workers-register-modal"
        destroyOnHidden
        mask={{ closable: false }}
        okText="Create credential"
        onCancel={() => {
          if (mutationKey !== "create") {
            setCreateOpen(false);
            createForm.resetFields();
          }
        }}
        onOk={() => createForm.submit()}
        open={createOpen}
        title="Register a Windows worker"
        width={480}
      >
        <Typography.Paragraph type="secondary">
          The worker starts in pending state. Its one-time token is shown after the credential is
          created.
        </Typography.Paragraph>
        <Form<CreateWorkerFields>
          form={createForm}
          layout="vertical"
          onFinish={(values) => void createWorker(values)}
          requiredMark={false}
        >
          <Form.Item
            label="Display name"
            name="displayName"
            rules={[
              { max: 128, message: "Use 128 characters or fewer." },
              {
                validator: async (_, value: unknown) => {
                  if (typeof value !== "string" || value.trim().length === 0) {
                    throw new Error("Enter a display name.");
                  }
                  if (!isSafeWorkerDisplayName(value)) {
                    throw new Error("Display names cannot contain worker credential material.");
                  }
                },
              },
            ]}
          >
            <Input
              autoFocus
              maxLength={128}
              placeholder="Example: Seattle review worker"
              showCount
            />
          </Form.Item>
        </Form>
      </Modal>

      <CredentialRevealModal
        credential={revealedCredential?.secret ?? null}
        onClose={() => setRevealedCredential(null)}
        onCopyError={() =>
          messageApi.error("Clipboard access failed. Select the token and copy it manually.")
        }
        onCopySuccess={() => messageApi.success("Token copied to the clipboard.")}
        operation={revealedCredential?.operation ?? "created"}
      />
    </section>
  );
}
