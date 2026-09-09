import type {
  PromptPreviewResponse,
  PromptTemplate,
  PromptVersionSummary,
} from "@agentic-review/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { GlobalPromptActivity } from "@/components/ConfigurationAudit";
import { configurationAuditQueryRoot } from "@/components/ConfigurationAudit/state";
import { configuration } from "@/services/configuration";
import { usePromptAvailable } from "./access";
import {
  assertPromptPreviewScope,
  buildPromptDraftSave,
  buildPromptPreview,
  buildPromptPublish,
  configurationErrorMessage,
  isPromptConflict,
  workflowLabels,
} from "./forms";
import { invalidatePromptPublication, promptQueryKeys } from "./queries";

function PublishedVersionDetails({
  templateId,
  versionId,
  onClose,
}: {
  templateId: string;
  versionId: string;
  onClose: () => void;
}) {
  const available = usePromptAvailable();
  const query = useQuery({
    queryKey: promptQueryKeys.version(templateId, versionId),
    queryFn: () => configuration.getPromptVersion(templateId, versionId),
    enabled: available,
  });
  return (
    <Drawer open title="Published prompt · read only" size={760} onClose={onClose}>
      {query.isPending ? (
        <Spin />
      ) : query.isError ? (
        <Alert
          type="error"
          showIcon
          title="Could not load version"
          description={configurationErrorMessage(query.error)}
          action={
            <Button
              disabled={!available}
              onClick={() => {
                if (available) void query.refetch();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : (
        <>
          <Descriptions
            column={1}
            size="small"
            items={[
              { key: "version", label: "Version", children: query.data.version },
              {
                key: "published",
                label: "Published",
                children: new Date(query.data.publishedAt).toLocaleString("en-US"),
              },
              {
                key: "author",
                label: "Published by",
                children: <span className="prompts-break">{query.data.createdBy}</span>,
              },
              {
                key: "schema",
                label: "Output schema",
                children: <code>{query.data.outputSchemaVersion}</code>,
              },
              {
                key: "digest",
                label: "Content SHA-256",
                children: <code className="prompts-break">{query.data.contentSha256}</code>,
              },
            ]}
          />
          <Typography.Paragraph type="secondary" className="prompts-section-note">
            Published content is immutable. Edit the template draft to prepare a new version.
          </Typography.Paragraph>
          <Input.TextArea
            className="prompts-readonly"
            readOnly
            aria-label="Published prompt content"
            autoSize={{ minRows: 14, maxRows: 26 }}
            value={query.data.content}
          />
        </>
      )}
    </Drawer>
  );
}

function PublishedVersions({ templateId }: { templateId: string }) {
  const available = usePromptAvailable();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: promptQueryKeys.versionList(templateId, page, pageSize),
    queryFn: () => configuration.listPromptVersions(templateId, { page, pageSize }),
    enabled: available,
  });
  return (
    <>
      <Typography.Paragraph type="secondary">
        Inspect immutable published versions. To roll back a workflow, choose an older published
        version in Workflow bindings.
      </Typography.Paragraph>
      {query.isError ? (
        <Alert
          showIcon
          type="error"
          title="Could not load published versions"
          description={configurationErrorMessage(query.error)}
          action={
            <Button
              disabled={!available}
              onClick={() => {
                if (available) void query.refetch();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : (
        <Table<PromptVersionSummary>
          rowKey="id"
          loading={query.isFetching}
          dataSource={query.data?.items ?? []}
          columns={[
            {
              title: "Version",
              dataIndex: "version",
              width: 90,
              render: (version: number) => <Tag>v{version}</Tag>,
            },
            {
              title: "Published",
              dataIndex: "publishedAt",
              width: 180,
              render: (value: string) => new Date(value).toLocaleString("en-US"),
            },
            {
              title: "Published by",
              dataIndex: "createdBy",
              render: (value: string) => <span className="prompts-break">{value}</span>,
            },
            {
              title: "",
              key: "view",
              width: 112,
              render: (_: unknown, item) => (
                <Button
                  type="link"
                  disabled={!available}
                  onClick={() => setSelectedVersionId(item.id)}
                >
                  Read version
                </Button>
              ),
            },
          ]}
          scroll={{ x: 580 }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No published versions. Save and publish the draft to create the first version."
              />
            ),
          }}
          pagination={{
            current: page,
            pageSize,
            total: query.data?.total ?? 0,
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
      {selectedVersionId && (
        <PublishedVersionDetails
          templateId={templateId}
          versionId={selectedVersionId}
          onClose={() => setSelectedVersionId(null)}
        />
      )}
    </>
  );
}

export function PromptEditor({
  templateId,
  repositoryId,
  onClose,
}: {
  templateId: string;
  repositoryId: string | null;
  onClose: () => void;
}) {
  const available = usePromptAvailable();
  const availableRef = useRef(available);
  availableRef.current = available;
  const queryClient = useQueryClient();
  const [modal, modalContext] = Modal.useModal();
  const [baseline, setBaseline] = useState<PromptTemplate | null>(null);
  const [content, setContent] = useState("");
  const [workItemId, setWorkItemId] = useState("");
  const [operation, setOperation] = useState<"save" | "publish" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PromptPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewGeneration = useRef(0);
  const templateQuery = useQuery({
    queryKey: promptQueryKeys.template(templateId),
    queryFn: () => configuration.getPrompt(templateId),
    enabled: available,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const dirty = baseline !== null && content !== baseline.draftContent;
  const busy = operation !== null;

  useEffect(() => {
    if (!baseline && templateQuery.data && !templateQuery.isFetching && !templateQuery.isError) {
      setBaseline(templateQuery.data);
      setContent(templateQuery.data.draftContent);
    }
  }, [baseline, templateQuery.data, templateQuery.isFetching, templateQuery.isError]);
  useEffect(() => {
    availableRef.current = available;
  }, [available]);
  useEffect(
    () => () => {
      availableRef.current = false;
      previewGeneration.current += 1;
    },
    [],
  );

  const clearPreview = () => {
    previewGeneration.current += 1;
    setPreview(null);
    setPreviewError(null);
    setPreviewing(false);
  };

  const reload = async () => {
    if (!available) return;
    try {
      const result = await templateQuery.refetch({ throwOnError: true });
      if (!result.data) return;
      setBaseline(result.data);
      setContent(result.data.draftContent);
      setError(null);
      setNeedsReload(false);
      clearPreview();
    } catch (failure) {
      setError(configurationErrorMessage(failure));
    }
  };

  const save = async () => {
    if (!available || !baseline || busy || needsReload) return;
    setOperation("save");
    setError(null);
    setNotice(null);
    try {
      const result = await configuration.savePromptDraft(
        templateId,
        buildPromptDraftSave(baseline, content),
      );
      setBaseline(result);
      setContent(result.draftContent);
      queryClient.setQueryData(promptQueryKeys.template(templateId), result);
      void queryClient.invalidateQueries({ queryKey: promptQueryKeys.templates });
      void queryClient.invalidateQueries({ queryKey: configurationAuditQueryRoot });
      setNotice("Draft saved. Publish it when it is ready for use.");
    } catch (failure) {
      setError(configurationErrorMessage(failure));
      setNeedsReload(isPromptConflict(failure));
    } finally {
      setOperation(null);
    }
  };

  const publish = async () => {
    if (!available || !baseline || busy || needsReload) return;
    setOperation("publish");
    setError(null);
    setNotice(null);
    try {
      const version = await configuration.publishPrompt(
        templateId,
        buildPromptPublish(baseline, content),
      );
      setNotice(
        `Version ${version.version} published. Select it in Workflow bindings to use it for future jobs. Publishing does not start a job.`,
      );
      await invalidatePromptPublication(queryClient, templateId);
      void queryClient.invalidateQueries({ queryKey: configurationAuditQueryRoot });
      if (!availableRef.current) {
        setError(
          "Publication succeeded. Verify access, then reload the updated draft before continuing.",
        );
        setNeedsReload(true);
        return;
      }
      try {
        const current = await configuration.getPrompt(templateId);
        setBaseline(current);
        setContent(current.draftContent);
        queryClient.setQueryData(promptQueryKeys.template(templateId), current);
      } catch (failure) {
        setError(
          `Publication succeeded, but the updated draft could not be loaded. ${configurationErrorMessage(failure)}`,
        );
        setNeedsReload(true);
      }
    } catch (failure) {
      setError(configurationErrorMessage(failure));
      setNeedsReload(isPromptConflict(failure));
    } finally {
      setOperation(null);
    }
  };

  const renderPreview = async () => {
    if (!available || !baseline) return;
    const generation = ++previewGeneration.current;
    setPreviewing(true);
    setPreview(null);
    setPreviewError(null);
    try {
      const request = buildPromptPreview(content, workItemId, baseline.workflowKind);
      const result = await configuration.previewPrompt(request);
      assertPromptPreviewScope(result, request, repositoryId);
      if (generation === previewGeneration.current) setPreview(result);
    } catch (failure) {
      if (generation === previewGeneration.current)
        setPreviewError(configurationErrorMessage(failure));
    } finally {
      if (generation === previewGeneration.current) setPreviewing(false);
    }
  };

  const close = () => {
    if (dirty) {
      modal.confirm({
        title: "Discard unsaved draft changes?",
        content: "The last saved draft will be kept. Changes in this editor will be discarded.",
        okText: "Discard changes",
        cancelText: "Keep editing",
        onOk: onClose,
      });
    } else onClose();
  };

  return (
    <Drawer
      open
      title={baseline?.name ?? "Prompt template"}
      size={880}
      onClose={close}
      closable={!busy}
      mask={{ closable: !busy }}
      keyboard={!busy}
    >
      {modalContext}
      {!baseline ? (
        templateQuery.isError ? (
          <Alert
            type="error"
            showIcon
            title="Could not load prompt"
            description={configurationErrorMessage(templateQuery.error)}
            action={
              <Button disabled={!available} onClick={reload}>
                Try again
              </Button>
            }
          />
        ) : (
          <Spin />
        )
      ) : (
        <>
          <div className="prompts-template-meta">
            <Tag>{workflowLabels[baseline.workflowKind]}</Tag>
            <code>{baseline.draftOutputSchemaVersion}</code>
          </div>
          {baseline.description && (
            <Typography.Paragraph type="secondary">{baseline.description}</Typography.Paragraph>
          )}
          {(baseline.workflowKind === "pr_ui" || baseline.workflowKind === "issue_validation") && (
            <Alert
              className="prompts-notice"
              type="info"
              showIcon
              title="Validation needs a configured driver"
              description="This prompt describes the task. Configure a compatible validation profile and driver separately before running this workflow."
            />
          )}
          <Tabs
            items={[
              {
                key: "draft",
                label: "Draft",
                disabled: !available,
                children: (
                  <>
                    {notice && (
                      <Alert className="prompts-notice" type="success" showIcon title={notice} />
                    )}
                    {error && (
                      <Alert
                        className="prompts-notice"
                        type={needsReload ? "warning" : "error"}
                        showIcon
                        title={
                          needsReload
                            ? "Reload the latest draft before continuing"
                            : "Could not complete the action"
                        }
                        description={
                          <>
                            <p>{error}</p>
                            {needsReload && (
                              <p>
                                Your editor content has not been submitted again. Reloading replaces
                                it with the current saved draft.
                              </p>
                            )}
                          </>
                        }
                        action={
                          needsReload ? (
                            <Button
                              disabled={!available}
                              loading={templateQuery.isFetching}
                              onClick={reload}
                            >
                              Reload latest draft
                            </Button>
                          ) : undefined
                        }
                      />
                    )}
                    <div className="prompts-editor-status">
                      <span>Draft revision {baseline.draftRevision}</span>
                      <Tag color={dirty ? "orange" : "default"}>
                        {dirty ? "Unsaved changes" : "Saved draft"}
                      </Tag>
                    </div>
                    <label className="prompts-field-label" htmlFor="prompt-draft-content">
                      Prompt content
                    </label>
                    <Input.TextArea
                      id="prompt-draft-content"
                      className="prompts-code-editor"
                      autoSize={{ minRows: 16, maxRows: 30 }}
                      value={content}
                      disabled={!available || busy}
                      spellCheck={false}
                      onChange={(event) => {
                        setContent(event.target.value);
                        setNotice(null);
                        clearPreview();
                      }}
                    />
                    <div className="prompts-editor-actions">
                      <Space wrap>
                        <Button
                          type="primary"
                          loading={operation === "save"}
                          disabled={
                            !available || !dirty || busy || needsReload || templateQuery.isFetching
                          }
                          onClick={save}
                        >
                          Save draft
                        </Button>
                        <Button
                          loading={operation === "publish"}
                          disabled={
                            !available || dirty || busy || needsReload || templateQuery.isFetching
                          }
                          onClick={publish}
                        >
                          Publish saved draft
                        </Button>
                      </Space>
                      <Typography.Text type="secondary">
                        {dirty
                          ? "Save your changes before publishing."
                          : "Publishing creates an immutable version."}
                      </Typography.Text>
                    </div>
                    <section className="prompts-preview" aria-labelledby="prompt-preview-heading">
                      <Typography.Title id="prompt-preview-heading" level={5}>
                        Preview current content
                      </Typography.Title>
                      <Typography.Paragraph type="secondary">
                        Preview does not save or publish. Optionally render with one work item's
                        context.
                      </Typography.Paragraph>
                      <Form layout="vertical">
                        <Form.Item
                          label="Work item ID (optional)"
                          htmlFor="prompt-preview-work-item"
                          extra="Use the exact internal work item ID, not a GitHub issue or pull request number."
                        >
                          <Input
                            id="prompt-preview-work-item"
                            value={workItemId}
                            maxLength={128}
                            placeholder="Exact work item ID"
                            disabled={!available || busy}
                            onChange={(event) => {
                              setWorkItemId(event.target.value);
                              clearPreview();
                            }}
                          />
                        </Form.Item>
                      </Form>
                      <Button
                        loading={previewing}
                        disabled={!available || busy || !content.trim()}
                        onClick={renderPreview}
                      >
                        Render preview
                      </Button>
                      {previewError && (
                        <Alert
                          className="prompts-preview-result"
                          type="error"
                          showIcon
                          title="Preview unavailable"
                          description={previewError}
                        />
                      )}
                      {preview && (
                        <div className="prompts-preview-result">
                          <div className="prompts-preview-meta">
                            <Tag>Preview only</Tag>
                            <span>
                              {preview.workItemId
                                ? `Work item: ${preview.workItemId}`
                                : "Template without work item context"}
                            </span>
                          </div>
                          <Descriptions
                            className="prompts-preview-digest"
                            column={1}
                            size="small"
                            items={[
                              {
                                key: "rendered-digest",
                                label: "Rendered SHA-256",
                                children: (
                                  <Typography.Text className="prompts-break" code copyable>
                                    {preview.contentSha256}
                                  </Typography.Text>
                                ),
                              },
                            ]}
                          />
                          <Input.TextArea
                            className="prompts-readonly"
                            readOnly
                            aria-label="Rendered prompt preview"
                            autoSize={{ minRows: 14, maxRows: 26 }}
                            value={preview.renderedContent}
                          />
                        </div>
                      )}
                    </section>
                  </>
                ),
              },
              {
                key: "versions",
                label: "Published versions",
                disabled: !available,
                children: <PublishedVersions templateId={templateId} />,
              },
              {
                key: "activity",
                label: "Template activity",
                disabled: !available,
                children: <GlobalPromptActivity templateId={templateId} enabled={available} />,
              },
            ]}
          />
        </>
      )}
    </Drawer>
  );
}
