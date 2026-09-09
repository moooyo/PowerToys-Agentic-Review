import type {
  DashboardReviewRunDetail,
  IssueReproductionRequestV1,
} from "@agentic-review/contracts";
import { ReloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Form,
  Input,
  Modal,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { OperatorAccessGate, useOperatorAccess } from "@/components/OperatorAccess";
import { reviewPermissionUnavailableReason } from "@/components/ReviewRuns/actions";
import { targetLabels, workflowLabels } from "@/pages/ValidationProfiles/forms";
import { configuration } from "@/services/configuration";
import type { WorkItem } from "@/services/review-control";
import { runs } from "@/services/runs";
import {
  createRunIntentRegistry,
  exactCommitPattern,
  initialRunProfileSelection,
  loadRunProfiles,
  maximumRunProfileCount,
  needsTestedSourceCommit,
  type RunCreationNotice,
  type RunProfileOption,
  runCreationError,
  runCreationPrerequisite,
  selectRunProfiles,
} from "./helpers";
import { ReproductionEditor } from "./ReproductionEditor";

export interface CreateReviewRunModalProps {
  readonly workItem: WorkItem | null;
  readonly onClose: () => void;
  readonly onCreated: (run: DashboardReviewRunDetail) => void;
}

function RunCreationSession({
  workItem,
  onClose,
  onCreated,
}: Omit<CreateReviewRunModalProps, "workItem"> & { readonly workItem: WorkItem }) {
  const access = useOperatorAccess(workItem.repositoryId);
  const permissionReason = reviewPermissionUnavailableReason(access);
  const [selection, setSelection] = useState<string[]>([]);
  const [testedSourceCommit, setTestedSourceCommit] = useState("");
  const [sourceExecutionAuthorized, setSourceExecutionAuthorized] = useState(false);
  const [reproduction, setReproduction] = useState<IssueReproductionRequestV1 | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<RunCreationNotice | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const selectionInitialized = useRef(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const intents = useRef(createRunIntentRegistry());
  const prerequisite = runCreationPrerequisite(workItem);
  const profilesQuery = useQuery({
    queryKey: ["review-run-create-profiles", workItem.repositoryId, workItem.kind],
    queryFn: () => loadRunProfiles(configuration, workItem.repositoryId, workItem.kind),
    enabled: prerequisite === null,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  const profiles = profilesQuery.data ?? [];
  const needsSource = needsTestedSourceCommit(workItem.kind, profiles, selection);
  const sourceIsValid = exactCommitPattern.test(testedSourceCommit);
  const profilesReady =
    profilesQuery.isSuccess && !profilesQuery.isFetching && selectionInitialized.current;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const currentProfiles = profilesQuery.data;
    if (!currentProfiles || profilesQuery.isFetching || profilesQuery.isError) return;
    try {
      if (!selectionInitialized.current) {
        setSelection(initialRunProfileSelection(currentProfiles));
        selectionInitialized.current = true;
      } else {
        setSelection((previous) => {
          try {
            return selectRunProfiles(currentProfiles, previous);
          } catch {
            return initialRunProfileSelection(currentProfiles);
          }
        });
      }
      setSelectionError(null);
    } catch (failure) {
      setSelectionError(runCreationError(failure).description);
    }
  }, [profilesQuery.data, profilesQuery.isError, profilesQuery.isFetching]);

  useEffect(() => {
    if (!needsSource) setSourceExecutionAuthorized(false);
  }, [needsSource]);

  const create = async () => {
    if (!access.can("review")) {
      setError({
        title: "Review access required",
        description: permissionReason ?? "Review access is required to create a run.",
      });
      return;
    }
    if (pending.current || prerequisite || !profilesReady || selectionError) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const input = intents.current.prepare({
        workItem,
        profiles,
        selectedProfileIds: selection,
        testedSourceCommit,
        sourceExecutionAuthorized,
        ...(reproduction === undefined ? {} : { reproduction }),
      });
      const created = await runs.create(workItem.repositoryId, workItem.id, input);
      if (mounted.current) onCreated(created);
    } catch (failure) {
      if (mounted.current) setError(runCreationError(failure));
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const changeSelection = (profileId: string, checked: boolean) => {
    try {
      setSelection(
        selectRunProfiles(
          profiles,
          checked ? [...selection, profileId] : selection.filter((id) => id !== profileId),
        ),
      );
      setSelectionError(null);
      setError(null);
      setSourceExecutionAuthorized(false);
    } catch (failure) {
      setSelectionError(runCreationError(failure).description);
    }
  };

  return (
    <Modal
      open
      title={workItem.kind === "pull_request" ? "Create review run" : "Create issue review run"}
      width={reproduction === undefined ? 760 : 960}
      onCancel={onClose}
      closable={!saving}
      keyboard={!saving}
      mask={{ closable: !saving }}
      cancelButtonProps={{ disabled: saving }}
      okText="Create review run"
      onOk={() => void create()}
      confirmLoading={saving}
      okButtonProps={{
        disabled:
          !access.can("review") ||
          Boolean(prerequisite) ||
          !profilesReady ||
          Boolean(selectionError) ||
          selection.length === 0 ||
          (reproduction !== undefined && runs.mode === "sample") ||
          (needsSource && (!sourceIsValid || !sourceExecutionAuthorized)),
      }}
      destroyOnHidden
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {permissionReason && (
          <Alert
            type="info"
            showIcon
            title="Review actions unavailable"
            description={permissionReason}
          />
        )}
        <div>
          <Typography.Text type="secondary">
            {workItem.repository} #{workItem.number}
          </Typography.Text>
          <Typography.Paragraph strong style={{ marginTop: 4, marginBottom: 0 }}>
            {workItem.title}
          </Typography.Paragraph>
        </div>
        {runs.mode === "sample" && reproduction === undefined && (
          <Alert
            type="info"
            showIcon
            title="Sample data"
            description="This preview creates a sample review run only. It does not send a production request or execute code."
          />
        )}
        {prerequisite ? (
          <Alert
            type="warning"
            showIcon
            title={prerequisite.title}
            description={prerequisite.description}
          />
        ) : (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              Choose the checks to include in this review run. Creating a run saves a plan; its
              details will show whether each check is ready or blocked. Creation does not mean that
              checks ran or passed.
            </Typography.Paragraph>
            {workItem.kind === "pull_request" && (
              <Form layout="vertical">
                <Form.Item label="Pull request head commit" style={{ marginBottom: 0 }}>
                  <Typography.Text code style={{ overflowWrap: "anywhere" }}>
                    {workItem.headSha}
                  </Typography.Text>
                  <div>
                    <Typography.Text type="secondary">
                      The run targets this head commit. Refresh the pull request if it has changed.
                    </Typography.Text>
                  </div>
                </Form.Item>
              </Form>
            )}
            <Space style={{ width: "100%", justifyContent: "space-between" }}>
              <Typography.Text strong>Validation profiles</Typography.Text>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={profilesQuery.isFetching}
                disabled={saving}
                onClick={() => void profilesQuery.refetch()}
              >
                Reload profiles
              </Button>
            </Space>
            {profilesQuery.isError ? (
              <Alert
                type="error"
                showIcon
                title="The active profile configuration could not be loaded"
                description={`${runCreationError(profilesQuery.error).description} All active bindings and their published versions must be available before creating a run.`}
              />
            ) : profilesQuery.isPending ? (
              <Skeleton active paragraph={{ rows: 4 }} />
            ) : profiles.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={`No enabled profiles apply to this ${workItem.kind === "pull_request" ? "pull request" : "issue"}. Publish and enable a matching validation profile for this repository.`}
              />
            ) : (
              <>
                <Table<RunProfileOption>
                  size="small"
                  rowKey={(option) => option.version.profileId}
                  dataSource={profiles}
                  loading={profilesQuery.isFetching}
                  pagination={false}
                  scroll={{ x: 560, y: 300 }}
                  columns={[
                    {
                      title: "Include",
                      key: "include",
                      width: 76,
                      render: (_, option) => (
                        <Checkbox
                          aria-label={`Include ${option.version.name}${option.version.required ? " (required)" : ""}`}
                          checked={
                            option.version.required || selection.includes(option.version.profileId)
                          }
                          disabled={
                            saving ||
                            profilesQuery.isFetching ||
                            option.version.required ||
                            (selection.length >= maximumRunProfileCount &&
                              !selection.includes(option.version.profileId))
                          }
                          onChange={(event) =>
                            changeSelection(option.version.profileId, event.target.checked)
                          }
                        />
                      ),
                    },
                    {
                      title: "Profile",
                      key: "profile",
                      render: (_, option) => (
                        <Space orientation="vertical" size={2}>
                          <Typography.Text strong>{option.version.name}</Typography.Text>
                          <Typography.Text type="secondary">
                            {workflowLabels[option.version.workflowKind]} ·{" "}
                            {targetLabels[option.version.target]}
                          </Typography.Text>
                        </Space>
                      ),
                    },
                    {
                      title: "Bound version",
                      key: "version",
                      width: 140,
                      render: (_, option) => (
                        <Space orientation="vertical" size={2}>
                          <Typography.Text>Version {option.version.version}</Typography.Text>
                          <Tag color={option.version.required ? "processing" : "default"}>
                            {option.version.required ? "Required" : "Optional"}
                          </Tag>
                        </Space>
                      ),
                    },
                  ]}
                />
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  {selection.length} of {maximumRunProfileCount} profiles selected. Required
                  profiles cannot be excluded. Versions shown are the current bindings; the created
                  run records the versions selected by the server.
                </Typography.Paragraph>
              </>
            )}
            {selectionError && (
              <Alert
                type="error"
                showIcon
                title="Check the profile selection"
                description={selectionError}
              />
            )}
            {workItem.kind === "issue" && profilesReady && (
              <ReproductionEditor
                profiles={profiles}
                selectedProfileIds={selection}
                value={reproduction}
                defaultClaim={workItem.title}
                disabled={saving || profilesQuery.isFetching}
                sample={runs.mode === "sample"}
                onChange={(next) => {
                  setReproduction(next);
                  setError(null);
                }}
              />
            )}
            {needsSource && (
              <Form layout="vertical" disabled={saving}>
                <Form.Item
                  label="Commit to validate"
                  required
                  validateStatus={testedSourceCommit && !sourceIsValid ? "error" : undefined}
                  help="Enter the exact 40- or 64-character lowercase commit SHA. A branch name or abbreviated SHA is not accepted."
                >
                  <Input
                    value={testedSourceCommit}
                    aria-label="Commit to validate"
                    placeholder="Full commit SHA"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      setTestedSourceCommit(event.target.value);
                      setSourceExecutionAuthorized(false);
                      setError(null);
                    }}
                  />
                </Form.Item>
                <Form.Item style={{ marginBottom: 0 }}>
                  <Checkbox
                    checked={sourceExecutionAuthorized}
                    onChange={(event) => setSourceExecutionAuthorized(event.target.checked)}
                  >
                    I authorize this operation to execute code at the specified commit.
                  </Checkbox>
                  <div>
                    <Typography.Text type="secondary">
                      Issue validation can run repository setup, build, test, and application
                      commands on a Worker. This is execution authorization for this commit.
                    </Typography.Text>
                  </div>
                </Form.Item>
              </Form>
            )}
            {workItem.kind === "issue" && !needsSource && profilesReady && selection.length > 0 && (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                Issue triage reads the report without authorizing repository code execution. Select
                an issue validation profile to validate a specific commit.
              </Typography.Paragraph>
            )}
          </>
        )}
        {error && (
          <Alert type="error" showIcon title={error.title} description={error.description} />
        )}
      </Space>
    </Modal>
  );
}

export function CreateReviewRunModal(props: CreateReviewRunModalProps) {
  if (!props.workItem) return null;
  return (
    <OperatorAccessGate repositoryId={props.workItem.repositoryId} permission="review">
      <RunCreationSession
        key={JSON.stringify([props.workItem.repositoryId, props.workItem.id])}
        workItem={props.workItem}
        onClose={props.onClose}
        onCreated={props.onCreated}
      />
    </OperatorAccessGate>
  );
}
