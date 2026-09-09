import type * as C from "@agentic-review/contracts";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useModel } from "@umijs/max";
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Drawer,
  Form,
  Input,
  Pagination,
  Row,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import {
  createHttpModelRuntimeRegistrationAdapter,
  type ModelRuntimeRegistrationAdapter,
} from "@/services/model-runtime-registrations";
import {
  initialRegistryMutationState,
  type RegistrationFields,
  type RegistryAccessState,
  RegistryMutationController,
  registrationFromFields,
  registryAccessState,
  registryErrorMessage,
} from "./state";

const adapter = createHttpModelRuntimeRegistrationAdapter();
export const modelRuntimeRegistryQueryRoot = ["model-runtime-registrations"] as const;
const pageSizeOptions = [1, 5, 10, 20, 50];
const allowedLabel = "Allow new evaluation selections";
const hashPattern = /^[a-f0-9]{64}$/u;
function Time({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString("en-US")}</time>;
}

export function ModelRuntimeRegistrations({
  service = adapter,
}: {
  service?: ModelRuntimeRegistrationAdapter;
}) {
  const access = useOperatorAccess();
  const { initialState } = useModel("@@initialState");
  const client = useQueryClient();
  const authorization = registryAccessState({ ...access, mode: String(access.identityKey[0]) });
  const session = JSON.stringify([access.identityKey, initialState?.authenticationEpoch ?? 0]);
  const revoked = authorization === "revoked" || authorization === "sample";
  useEffect(() => {
    const clear = () => {
      const queryKey = [...modelRuntimeRegistryQueryRoot, session];
      void client.cancelQueries({ queryKey });
      client.removeQueries({ queryKey });
    };
    if (revoked) clear();
    return clear;
  }, [client, session, revoked]);
  if (authorization === "sample")
    return (
      <Card title="Model runtime registrations">
        <Alert
          type="info"
          showIcon
          title="Connect to manage model runtime registrations"
          description="This panel requires a connected control plane and platform administrator access. Sample mode does not register or change runtimes."
        />
      </Card>
    );
  if (authorization === "revoked" || !access.principal)
    return (
      <Card title="Model runtime registrations">
        <Alert
          type="info"
          showIcon
          title="Platform administrator access required"
          description="Refresh access to manage expected runtime configurations."
          action={
            <Button onClick={() => void access.refresh()} loading={access.checking}>
              Refresh access
            </Button>
          }
        />
      </Card>
    );
  return (
    <RegistryContent
      key={session}
      service={service}
      session={session}
      actor={access.principal}
      authorization={authorization}
      refreshAccess={() => void access.refresh()}
    />
  );
}

function RegistryContent({
  service,
  session,
  actor,
  authorization,
  refreshAccess,
}: {
  service: ModelRuntimeRegistrationAdapter;
  session: string;
  actor: C.OperatorPrincipal;
  authorization: RegistryAccessState;
  refreshAccess: () => void;
}) {
  const readable = authorization === "authorized";
  const client = useQueryClient();
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(20);
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [state, setState] = useState(initialRegistryMutationState);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const controller = useRef<RegistryMutationController | null>(null);
  const currentReadable = useRef(readable);
  currentReadable.current = readable;
  useEffect(() => {
    const value = new RegistryMutationController(service, setState);
    value.setAuthorization(currentReadable.current);
    controller.current = value;
    return () => {
      value.close();
      if (controller.current === value) controller.current = null;
    };
  }, [service]);
  useEffect(() => {
    controller.current?.setAuthorization(readable);
  }, [readable]);
  const queryPrefix = [...modelRuntimeRegistryQueryRoot, session];
  const list = useQuery({
    queryKey: [...queryPrefix, "list", page, pageSize, filter],
    queryFn: ({ signal }) =>
      service.list(
        { page, pageSize, ...(filter === "all" ? {} : { enabled: filter === "enabled" }) },
        signal,
      ),
    enabled: readable,
    retry: false,
    gcTime: 0,
  });
  const blocked = !readable || state.busy || state.uncertain;
  const changed = async (result: C.ModelRuntimeStatusV1 | null) => {
    if (!result) return;
    setSuccess(`Saved ${result.registration.name}, control version ${result.control.version}.`);
    setRegisterOpen(false);
    setSelected(result.registration.id);
    await client.invalidateQueries({ queryKey: queryPrefix });
  };
  const create = async (fields: RegistrationFields) => {
    if (blocked) return;
    setFormError(null);
    setSuccess(null);
    try {
      const request = registrationFromFields(fields, globalThis.crypto.randomUUID());
      await changed(
        (await controller.current?.submit({ kind: "register", request, actor })) ?? null,
      );
    } catch (error) {
      setFormError(registryErrorMessage(error));
    }
  };
  const control = async (
    current: C.ModelRuntimeStatusV1,
    values: { enabled: boolean; reason: string },
  ) => {
    if (blocked) return;
    setFormError(null);
    setSuccess(null);
    try {
      const active = controller.current;
      const result =
        (await active?.submit({
          kind: "control",
          registrationId: current.registration.id,
          actor,
          request: {
            changeId: globalThis.crypto.randomUUID(),
            expectedVersion: current.control.version,
            enabled: values.enabled,
            reason: values.reason,
          },
        })) ?? null;
      await changed(result);
      // A definitive conflict must refresh the current control before another edit.
      // An uncertain intent retains its original CAS even if this read sees newer data.
      if (!result && active !== null && controller.current === active)
        await client.invalidateQueries({
          queryKey: [...queryPrefix, "detail", current.registration.id],
        });
    } catch (error) {
      setFormError(registryErrorMessage(error));
    }
  };
  const retry = async () => {
    await changed((await controller.current?.retry()) ?? null);
  };
  if (!readable)
    return (
      <Card title="Model runtime registrations">
        {authorization === "checking" ? (
          <>
            <Skeleton active />
            <Typography.Paragraph>Verifying current administrator access...</Typography.Paragraph>
          </>
        ) : (
          <Alert
            type="warning"
            showIcon
            title="Administrator access could not be verified"
            description="Registry details and actions are hidden until current access is verified. Any unconfirmed change is retained for this signed-in session."
            action={<Button onClick={refreshAccess}>Refresh access</Button>}
          />
        )}
      </Card>
    );
  return (
    <Card
      title="Model runtime registrations"
      extra={
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void client.invalidateQueries({ queryKey: queryPrefix })}
            loading={list.isFetching}
          >
            Refresh
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={blocked}
            onClick={() => {
              setFormError(null);
              setRegisterOpen(true);
            }}
          >
            Register expected runtime
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        Save the expected model and runtime identity for future evaluation selections. Registration
        does not verify a runtime, prove its availability, or start a model. Existing evaluation
        configurations remain frozen.
      </Typography.Paragraph>
      {success && <Alert type="success" showIcon title={success} style={{ marginBottom: 16 }} />}
      {(state.error || formError) && (
        <Alert
          type="error"
          showIcon
          title="The change could not be confirmed"
          description={formError ?? state.error}
          style={{ marginBottom: 16 }}
        />
      )}
      {state.uncertain && (
        <Alert
          type="warning"
          showIcon
          title="Keep the original change until its outcome is confirmed"
          description="The server may already have saved this change. Retry sends the same change ID, identity, actor and expected version. New changes remain disabled until the outcome is known."
          action={
            <Button loading={state.busy} onClick={() => void retry()}>
              Retry original change
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}
      {state.conflict && (
        <Alert
          type="info"
          showIcon
          title="Refresh before editing again"
          description="The previous version is no longer current. Inspect the refreshed control and submit a deliberate new change."
          action={
            <Button onClick={() => void client.invalidateQueries({ queryKey: queryPrefix })}>
              Refresh current control
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}
      <Space style={{ marginBottom: 16 }}>
        <Typography.Text>Selection control</Typography.Text>
        <Select
          aria-label="Filter model runtime selection control"
          value={filter}
          style={{ width: 220 }}
          options={[
            { value: "all", label: "All registrations" },
            { value: "enabled", label: "New selections allowed" },
            { value: "disabled", label: "New selections disabled" },
          ]}
          onChange={(value) => {
            setFilter(value);
            setPage(1);
          }}
        />
      </Space>
      {list.isError && (
        <Alert
          type="error"
          showIcon
          title="Registrations could not be loaded"
          description={registryErrorMessage(list.error)}
        />
      )}
      <Table<C.ModelRuntimeStatusV1>
        rowKey={(value) => value.registration.id}
        loading={list.isFetching}
        dataSource={list.isError ? [] : (list.data?.items ?? [])}
        pagination={false}
        locale={{ emptyText: "No model runtime registrations on this page." }}
        scroll={{ x: 760 }}
        columns={[
          {
            title: "Registration",
            key: "name",
            render: (_, value) => (
              <Button type="link" onClick={() => setSelected(value.registration.id)}>
                {value.registration.name}
              </Button>
            ),
          },
          {
            title: "Requested model",
            key: "model",
            render: (_, value) => value.registration.requestedModel,
          },
          {
            title: allowedLabel,
            key: "enabled",
            render: (_, value) => (
              <Tag color={value.control.enabled ? "blue" : "default"}>
                {value.control.enabled ? "Allowed" : "Disabled"}
              </Tag>
            ),
          },
          { title: "Control version", key: "version", render: (_, value) => value.control.version },
          {
            title: "Registered",
            key: "created",
            render: (_, value) => <Time value={value.registration.createdAt} />,
          },
        ]}
      />
      <Pagination
        current={page}
        pageSize={pageSize}
        total={list.isError ? 0 : (list.data?.total ?? 0)}
        showSizeChanger
        pageSizeOptions={pageSizeOptions}
        onChange={(next, size) => {
          setPage(size === pageSize ? next : 1);
          setPageSize(size);
        }}
        style={{ marginTop: 16 }}
      />
      <Drawer
        title="Register expected runtime"
        open={registerOpen}
        size="large"
        onClose={() => setRegisterOpen(false)}
        destroyOnHidden
      >
        <RegistrationForm disabled={blocked} busy={state.busy} onFinish={create} />
        {(formError || state.error) && (
          <Alert
            type="error"
            showIcon
            title="Registration was not confirmed"
            description={formError ?? state.error}
          />
        )}
        {state.uncertain && (
          <Button onClick={() => void retry()} loading={state.busy}>
            Retry original change
          </Button>
        )}
      </Drawer>
      {selected && (
        <RegistrationDetail
          key={selected}
          id={selected}
          service={service}
          prefix={queryPrefix}
          disabled={blocked}
          busy={state.busy}
          onClose={() => setSelected(null)}
          onControl={control}
          error={formError ?? state.error}
          uncertain={state.uncertain}
          onRetry={() => void retry()}
        />
      )}
    </Card>
  );
}

function RegistrationForm({
  disabled,
  busy,
  onFinish,
}: {
  disabled: boolean;
  busy: boolean;
  onFinish: (values: RegistrationFields) => Promise<void>;
}) {
  const text = (name: keyof RegistrationFields, label: string, maximum: number, hash = false) => (
    <Col xs={24} md={hash ? 24 : 12} key={name}>
      <Form.Item
        name={name}
        label={label}
        rules={[
          { required: true, whitespace: true, message: `${label} is required.` },
          { max: maximum },
          ...(hash
            ? [
                {
                  pattern: hashPattern,
                  message: "Enter a complete lowercase SHA-256 digest (64 characters).",
                },
              ]
            : []),
        ]}
      >
        <Input maxLength={maximum} autoComplete="off" spellCheck={false} />
      </Form.Item>
    </Col>
  );
  return (
    <Form<RegistrationFields>
      layout="vertical"
      disabled={disabled}
      initialValues={{ enabled: false }}
      onFinish={(values) => void onFinish(values)}
    >
      <Alert
        type="info"
        showIcon
        title="Immutable expected configuration"
        description="Enter reviewed runtime identity values. Credentials and endpoint URLs are not accepted here. A saved registration records expectations; execution still requires independent identity checks."
        style={{ marginBottom: 20 }}
      />
      <Row gutter={16}>
        {text("name", "Registration name", 128)}
        {text("requestedModel", "Requested model or alias", 1024)}
        {text("providerId", "Expected provider ID", 128)}
        {text("modelId", "Expected model ID", 1024)}
        {text("clientVersion", "Expected Codex CLI version", 128)}
      </Row>
      <Collapse
        defaultActiveKey={["identity"]}
        items={[
          {
            key: "identity",
            label: "Expected runtime digests",
            children: (
              <Row gutter={16}>
                {text("endpointSha256", "Endpoint SHA-256", 64, true)}
                {text("executableSha256", "Client executable SHA-256", 64, true)}
                {text("launchPolicySha256", "Client launch policy SHA-256", 64, true)}
                {text("relayImplementationSha256", "Relay implementation SHA-256", 64, true)}
                {text("relayPolicySha256", "Relay policy SHA-256", 64, true)}
              </Row>
            ),
          },
        ]}
      />
      <Form.Item
        name="enabled"
        label={allowedLabel}
        valuePropName="checked"
        style={{ marginTop: 20 }}
      >
        <Switch />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={busy} disabled={disabled}>
        Save expected registration
      </Button>
    </Form>
  );
}

function RegistrationDetail({
  id,
  service,
  prefix,
  disabled,
  busy,
  onClose,
  onControl,
  error,
  uncertain,
  onRetry,
}: {
  id: string;
  service: ModelRuntimeRegistrationAdapter;
  prefix: readonly unknown[];
  disabled: boolean;
  busy: boolean;
  onClose: () => void;
  onControl: (
    status: C.ModelRuntimeStatusV1,
    values: { enabled: boolean; reason: string },
  ) => Promise<void>;
  error: string | null;
  uncertain: boolean;
  onRetry: () => void;
}) {
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(20);
  const detail = useQuery({
    queryKey: [...prefix, "detail", id],
    queryFn: ({ signal }) => service.get(id, signal),
    retry: false,
    gcTime: 0,
  });
  const history = useQuery({
    queryKey: [...prefix, "history", id, page, pageSize],
    queryFn: ({ signal }) => service.history(id, { page, pageSize }, signal),
    retry: false,
    gcTime: 0,
  });
  const value = !detail.isError ? detail.data : undefined;
  const registration = value?.registration;
  return (
    <Drawer
      title="Expected runtime registration"
      open
      size="large"
      onClose={onClose}
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        title="Registered expectations, not runtime verification"
        description="The identity below is immutable. Selection control affects new evaluation selections and does not rewrite existing batches."
        style={{ marginBottom: 20 }}
      />
      {detail.isFetching && <Skeleton active />}
      {detail.isError && (
        <Alert
          type="error"
          showIcon
          title="Registration could not be loaded"
          description={registryErrorMessage(detail.error)}
          action={<Button onClick={() => void detail.refetch()}>Retry read</Button>}
        />
      )}
      {registration && value && (
        <>
          <Descriptions
            column={1}
            bordered
            size="small"
            items={[
              {
                key: "id",
                label: "Registration ID",
                children: <Typography.Text code>{registration.id}</Typography.Text>,
              },
              { key: "name", label: "Name", children: registration.name },
              { key: "model", label: "Requested model", children: registration.requestedModel },
              { key: "expected", label: "Expected model", children: registration.identity.modelId },
              {
                key: "provider",
                label: "Expected provider",
                children: registration.identity.providerId,
              },
              {
                key: "digest",
                label: "Identity SHA-256",
                children: (
                  <Typography.Text code style={{ overflowWrap: "anywhere" }}>
                    {registration.identitySha256}
                  </Typography.Text>
                ),
              },
              {
                key: "created",
                label: "Registered",
                children: <Time value={registration.createdAt} />,
              },
              {
                key: "actor",
                label: "Registered by",
                children: `${registration.createdBy.issuer} / ${registration.createdBy.subject}`,
              },
            ]}
          />
          <Collapse
            style={{ marginTop: 16 }}
            items={[
              {
                key: "identity",
                label: "Frozen expected identity",
                children: (
                  <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {JSON.stringify(registration.identity, null, 2)}
                  </pre>
                ),
              },
            ]}
          />
          <Typography.Title level={5}>
            Selection control · version {value.control.version}
          </Typography.Title>
          <Form<{ enabled: boolean; reason: string }>
            key={value.control.version}
            layout="vertical"
            initialValues={{ enabled: value.control.enabled }}
            disabled={
              disabled || detail.isFetching || value.control.version === Number.MAX_SAFE_INTEGER
            }
            onFinish={(values) => void onControl(value, values)}
          >
            <Form.Item name="enabled" label={allowedLabel} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item
              name="reason"
              label="Reason for this change"
              rules={[{ required: true, whitespace: true }, { max: 2048 }]}
            >
              <Input.TextArea maxLength={2048} rows={3} />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              disabled={
                disabled || detail.isFetching || value.control.version === Number.MAX_SAFE_INTEGER
              }
              loading={busy}
            >
              Save selection control
            </Button>
          </Form>
          {error && (
            <Alert
              type="error"
              showIcon
              title="Control change was not confirmed"
              description={error}
              style={{ marginTop: 16 }}
            />
          )}
          {uncertain && (
            <Button loading={busy} onClick={onRetry}>
              Retry original change
            </Button>
          )}
        </>
      )}
      <Typography.Title level={5}>Registration history</Typography.Title>
      {history.isError && (
        <Alert
          type="error"
          showIcon
          title="History could not be loaded"
          description={registryErrorMessage(history.error)}
          action={<Button onClick={() => void history.refetch()}>Retry history</Button>}
        />
      )}
      <Table<C.ModelRuntimeAuditEventV1>
        rowKey="id"
        pagination={false}
        loading={history.isFetching}
        dataSource={history.isError ? [] : (history.data?.items ?? [])}
        scroll={{ x: 560 }}
        columns={[
          { title: "Version", dataIndex: "version" },
          { title: "Change", dataIndex: "operation" },
          {
            title: "Selections",
            key: "enabled",
            render: (_, event) => (event.enabled ? "Allowed" : "Disabled"),
          },
          {
            title: "Reason",
            dataIndex: "reason",
            render: (reason: string | null) => reason ?? "Initial registration",
          },
          {
            title: "By",
            key: "actor",
            render: (_, event) => `${event.createdBy.issuer} / ${event.createdBy.subject}`,
          },
          { title: "At", key: "time", render: (_, event) => <Time value={event.createdAt} /> },
        ]}
      />
      <Pagination
        current={page}
        pageSize={pageSize}
        total={history.isError ? 0 : (history.data?.total ?? 0)}
        pageSizeOptions={pageSizeOptions}
        showSizeChanger
        onChange={(next, size) => {
          setPage(size === pageSize ? next : 1);
          setPageSize(size);
        }}
        style={{ marginTop: 16 }}
      />
    </Drawer>
  );
}
