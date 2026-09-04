import {
  KeyOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
} from "@ant-design/icons";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import { PageContainer, ProTable } from "@ant-design/pro-components";
import {
  Button,
  Form,
  Input,
  Modal,
  message,
  Progress,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useRef, useState } from "react";
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
  type WorkerInventoryRow,
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

export default function WorkersPage() {
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
  const [mutationKey, setMutationKey] = useState<MutationKey | null>(null);
  const [revealedCredential, setRevealedCredential] = useState<RevealedCredential | null>(null);
  const [messageApi, messageContext] = message.useMessage();
  const [modalApi, modalContext] = Modal.useModal();

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
          <Space direction="vertical" size={6}>
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
          <Space direction="vertical" size={6}>
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
      title: "Search",
      dataIndex: "search",
      hideInTable: true,
      fieldProps: { placeholder: "Name, node, instance, or location" },
    },
    {
      title: "Worker",
      dataIndex: "workerNodeId",
      width: 280,
      search: false,
      render: (_, row) => (
        <Space className="worker-inventory__identity" direction="vertical" size={0}>
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
        </Space>
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
          <Space direction="vertical" size={0}>
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
    <PageContainer
      className="operational-page"
      header={{
        title: "Workers",
        subTitle: "Registration credentials and Windows worker runtime state",
      }}
    >
      {messageContext}
      {modalContext}

      <ProTable<WorkerInventoryRow>
        actionRef={actionRef}
        cardBordered={false}
        className="operational-table"
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
        headerTitle={
          <Space size={8}>
            <SafetyCertificateOutlined />
            <span>Worker access roster</span>
          </Space>
        }
        options={{ density: true, fullScreen: true, reload: reloadInventory, setting: true }}
        pagination={{
          defaultPageSize: DEFAULT_WORKER_INVENTORY_PAGE_SIZE,
          pageSizeOptions: [50, 100, MAX_WORKER_INVENTORY_PAGE_SIZE],
          showSizeChanger: true,
        }}
        request={async (params) => {
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
        search={{ labelWidth: "auto" }}
        size="small"
        toolBarRender={() => [
          <Button
            disabled={mutationKey !== null}
            icon={<PlusOutlined />}
            key="register"
            onClick={() => setCreateOpen(true)}
            type="primary"
          >
            Register worker
          </Button>,
        ]}
      />

      <Modal
        cancelButtonProps={{ disabled: mutationKey === "create" }}
        confirmLoading={mutationKey === "create"}
        destroyOnHidden
        maskClosable={false}
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
    </PageContainer>
  );
}
