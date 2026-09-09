import type * as C from "@agentic-review/contracts";
import { Alert, Button, Card, Descriptions, Select, Space, Table, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import { useEvaluationPage, useEvaluationQuery } from "./context";
import { CaseSourceLabel, FrozenSourceLabel, SourceDetails } from "./Sources";
import { collectCatalog, errorMessage } from "./state";

export function PublishedVersion({
  suiteId,
  preferredVersionId,
  active,
  sources,
}: {
  suiteId: string;
  preferredVersionId: string | null;
  active: boolean;
  sources: C.EvaluationSourceSummaryV1[];
}) {
  const page = useEvaluationPage();
  const [selected, setSelected] = useState<string | null>(preferredVersionId),
    [caseId, setCaseId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const scope = { repositoryId: page.repositoryId, suiteId };
  const versions = useEvaluationQuery(
    ["versions", suiteId],
    (signal) =>
      collectCatalog((number) =>
        page.api.listSuiteVersions(scope, { page: number, pageSize: 50 }, signal),
      ),
    active,
  );
  useEffect(() => {
    if (active && selected === null) {
      const initialVersionId = preferredVersionId ?? versions.data?.[0]?.id;
      if (initialVersionId) setSelected(initialVersionId);
    }
  }, [active, selected, preferredVersionId, versions.data]);
  const versionId = selected;
  const versionScope = { ...scope, versionId: versionId ?? "" };
  const version = useEvaluationQuery(
    ["version", suiteId, versionId],
    (signal) => page.api.getSuiteVersion(versionScope, signal),
    active && versionId !== null,
  );
  const cases = useEvaluationQuery(
    ["cases", suiteId, versionId],
    (signal) => page.api.listSuiteCases(versionScope, signal),
    active && versionId !== null,
  );
  const detail = useEvaluationQuery(
    ["case", suiteId, versionId, caseId],
    (signal) => page.api.getSuiteCase({ ...versionScope, caseId: caseId ?? "" }, signal),
    active && versionId !== null && caseId !== null,
  );
  const error = versions.error ?? version.error ?? cases.error ?? detail.error;
  return (
    <div className="evaluation-version">
      <Alert
        type="info"
        showIcon
        title="Published versions are immutable"
        description="These sources and expectations belong to this exact version. Later draft edits cannot change them."
      />
      {error ? (
        <Alert
          type="error"
          title="Published version unavailable"
          description={errorMessage(error)}
        />
      ) : null}
      <Select
        aria-label="Published version"
        value={versionId ?? undefined}
        placeholder="No published versions"
        loading={versions.isFetching}
        className="evaluation-version-select"
        options={(versions.data ?? []).map((entry) => ({
          value: entry.id,
          label: `Version ${entry.version} · ${entry.caseCount} cases · ${entry.createdAt}`,
        }))}
        onChange={(id) => {
          setSelected(id);
          setCaseId(null);
          setSourceId(null);
        }}
      />
      {version.data ? (
        <Descriptions
          size="small"
          column={1}
          items={[
            {
              key: "revision",
              label: "Published from draft",
              children: `Revision ${version.data.sourceDraftRevision}`,
            },
            {
              key: "source",
              label: "Source manifest",
              children: (
                <Typography.Text copyable>{version.data.sourceManifestSha256}</Typography.Text>
              ),
            },
            {
              key: "expected",
              label: "Expectation manifest",
              children: (
                <Typography.Text copyable>{version.data.expectationManifestSha256}</Typography.Text>
              ),
            },
          ]}
        />
      ) : null}
      <Table<C.EvaluationSuiteCaseSummaryV1>
        rowKey="caseId"
        size="small"
        pagination={false}
        loading={active && !!versionId && cases.isPending}
        dataSource={cases.data?.items ?? []}
        columns={[
          {
            title: "Case",
            key: "case",
            render: (_, entry) => (
              <div>
                <Button
                  type="link"
                  className="evaluation-name"
                  onClick={() => {
                    setCaseId(entry.caseId);
                    setSourceId(null);
                  }}
                >
                  {entry.title}
                </Button>
                <CaseSourceLabel
                  sourceId={entry.sourceId}
                  known={sources.find((source) => source.id === entry.sourceId)}
                />
              </div>
            ),
          },
          {
            title: "Applicability",
            key: "applicability",
            render: (_, entry) => (
              <Tag>
                {entry.applicability.state === "applicable" ? "Applicable" : "Not applicable"}
              </Tag>
            ),
          },
          { title: "Checks", dataIndex: "criterionCount", key: "checks" },
          {
            title: "Finding labels",
            key: "labels",
            render: (_, entry) => `${entry.annotation} · ${entry.expectedFindingCount}`,
          },
        ]}
      />
      {detail.data ? (
        <Card size="small" title={detail.data.expectation.title}>
          <FrozenSourceLabel source={detail.data.source} />
          <Space>
            <Tag>{detail.data.expectation.findings.annotation}</Tag>
            <Button size="small" onClick={() => setSourceId(detail.data?.source.id ?? null)}>
              View frozen body
            </Button>
          </Space>
          {detail.data.expectation.applicability.state === "not_applicable" ? (
            <Alert
              type="info"
              title="Not applicable"
              description={detail.data.expectation.applicability.reason}
            />
          ) : null}
          <Table<C.EvaluationSuiteDraftCase["criteria"][number]>
            rowKey="criterionId"
            size="small"
            pagination={false}
            dataSource={detail.data.expectation.criteria}
            columns={[
              { title: "Expected check", dataIndex: "description", key: "description" },
              { title: "Expected outcome", dataIndex: "expectedOutcome", key: "outcome" },
              {
                title: "Scope",
                key: "scope",
                render: (_, criterion) =>
                  criterion.applicability.state === "applicable"
                    ? "Applicable"
                    : criterion.applicability.reason,
              },
            ]}
          />
          <Typography.Paragraph>
            {detail.data.expectation.findings.annotation === "unlabeled"
              ? "Finding expectations are unlabeled. This is not a negative example."
              : detail.data.expectation.findings.expected.length === 0
                ? detail.data.expectation.findings.annotation === "complete"
                  ? "Complete labels declare that no findings are expected."
                  : "No known positives are listed; other findings remain unassessed."
                : detail.data.expectation.findings.annotation === "complete"
                  ? "Exhaustive expected findings:"
                  : "Known positive findings only:"}
          </Typography.Paragraph>
          {detail.data.expectation.findings.expected.length ? (
            <ul>
              {detail.data.expectation.findings.expected.map((finding) => (
                <li key={finding.expectedFindingId}>
                  {finding.description}
                  <div className="evaluation-meta">{finding.expectedFindingId}</div>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}
      {sourceId ? <SourceDetails sourceId={sourceId} onClose={() => setSourceId(null)} /> : null}
    </div>
  );
}
