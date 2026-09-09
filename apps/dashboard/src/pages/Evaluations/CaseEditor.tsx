import type * as C from "@agentic-review/contracts";
import { Alert, Button, Card, Form, Input, Select, Space, Switch, Tag, Typography } from "antd";
import { CaseSourceLabel } from "./Sources";
import { changeAnnotation, newCriterion, newIdentity } from "./state";

function ApplicabilityEditor({
  value,
  onChange,
}: {
  value: C.EvaluationSuiteDraftCase["applicability"];
  onChange: (value: C.EvaluationSuiteDraftCase["applicability"]) => void;
}) {
  return (
    <div className="evaluation-applicability">
      <Space>
        <Switch
          checked={value.state === "applicable"}
          onChange={(checked) =>
            onChange(checked ? { state: "applicable" } : { state: "not_applicable", reason: "" })
          }
        />
        <span>Applicable</span>
      </Space>
      {value.state === "not_applicable" ? (
        <Input.TextArea
          aria-label="Reason this item is not applicable"
          value={value.reason}
          onChange={(event) => onChange({ state: "not_applicable", reason: event.target.value })}
          maxLength={2048}
          autoSize={{ minRows: 1, maxRows: 4 }}
          placeholder="Explain why this item is outside the evaluation scope"
        />
      ) : null}
    </div>
  );
}

export function CaseEditor({
  value,
  sources,
  disabled,
  onChange,
}: {
  value: C.EvaluationSuiteDraft;
  sources: C.EvaluationSourceSummaryV1[];
  disabled: boolean;
  onChange: (value: C.EvaluationSuiteDraft) => void;
}) {
  const updateCase = (
    id: string,
    transform: (entry: C.EvaluationSuiteDraftCase) => C.EvaluationSuiteDraftCase,
  ) => {
    if (disabled) return;
    onChange({
      ...value,
      cases: value.cases.map((entry) => (entry.caseId === id ? transform(entry) : entry)),
    });
  };
  return (
    <Form layout="vertical" disabled={disabled}>
      <Form.Item label="Sample set name" required>
        <Input
          value={value.name}
          maxLength={128}
          onChange={(event) => {
            if (!disabled) onChange({ ...value, name: event.target.value });
          }}
        />
      </Form.Item>
      <Form.Item label="Description">
        <Input.TextArea
          value={value.description}
          maxLength={2048}
          autoSize={{ minRows: 2, maxRows: 5 }}
          onChange={(event) => {
            if (!disabled) onChange({ ...value, description: event.target.value });
          }}
        />
      </Form.Item>
      {value.cases.length === 0 ? (
        <Alert
          type="info"
          showIcon
          title="Add a case from the frozen source library below"
          description="An empty draft can be saved. Publishing requires at least one applicable case."
        />
      ) : null}
      <div className="evaluation-case-list">
        {value.cases.map((entry, index) => (
          <Card
            key={entry.caseId}
            size="small"
            title={
              <CaseSourceLabel
                sourceId={entry.sourceId}
                known={sources.find((source) => source.id === entry.sourceId)}
              />
            }
            extra={
              <Button
                danger
                size="small"
                disabled={disabled}
                onClick={() => {
                  if (!disabled)
                    onChange({
                      ...value,
                      cases: value.cases.filter((candidate) => candidate.caseId !== entry.caseId),
                    });
                }}
              >
                Remove case
              </Button>
            }
          >
            <p className="evaluation-meta">
              Case {index + 1} · {entry.caseId}
            </p>
            <Form.Item label="Case title" required>
              <Input
                value={entry.title}
                maxLength={256}
                onChange={(event) =>
                  updateCase(entry.caseId, (old) => ({ ...old, title: event.target.value }))
                }
              />
            </Form.Item>
            <Form.Item label="Case applicability">
              <ApplicabilityEditor
                value={entry.applicability}
                onChange={(applicability) =>
                  updateCase(entry.caseId, (old) => ({ ...old, applicability }))
                }
              />
            </Form.Item>
            <div className="evaluation-subheading">
              <Typography.Text strong>Expected checks</Typography.Text>
              <Button
                size="small"
                disabled={disabled || entry.criteria.length >= 96}
                onClick={() =>
                  updateCase(entry.caseId, (old) => ({
                    ...old,
                    criteria: [...old.criteria, newCriterion()],
                  }))
                }
              >
                Add criterion
              </Button>
            </div>
            <p className="evaluation-meta">
              Declare the known outcome. A failed check can be the correct result for a known
              defect.
            </p>
            {entry.criteria.map((criterion) => (
              <div className="evaluation-criterion" key={criterion.criterionId}>
                <span className="evaluation-meta">{criterion.criterionId}</span>
                <Form.Item label="Criterion" required>
                  <Input.TextArea
                    value={criterion.description}
                    maxLength={2048}
                    autoSize={{ minRows: 1, maxRows: 4 }}
                    onChange={(event) =>
                      updateCase(entry.caseId, (old) => ({
                        ...old,
                        criteria: old.criteria.map((item) =>
                          item.criterionId === criterion.criterionId
                            ? { ...item, description: event.target.value }
                            : item,
                        ),
                      }))
                    }
                  />
                </Form.Item>
                <div className="evaluation-field-grid">
                  <Form.Item label="Expected outcome">
                    <Select
                      value={criterion.expectedOutcome}
                      options={[
                        { value: "passed", label: "Passed" },
                        { value: "failed", label: "Failed" },
                      ]}
                      onChange={(expectedOutcome) =>
                        updateCase(entry.caseId, (old) => ({
                          ...old,
                          criteria: old.criteria.map((item) =>
                            item.criterionId === criterion.criterionId
                              ? { ...item, expectedOutcome }
                              : item,
                          ),
                        }))
                      }
                    />
                  </Form.Item>
                  <Form.Item label="Criterion applicability">
                    <ApplicabilityEditor
                      value={criterion.applicability}
                      onChange={(applicability) =>
                        updateCase(entry.caseId, (old) => ({
                          ...old,
                          criteria: old.criteria.map((item) =>
                            item.criterionId === criterion.criterionId
                              ? { ...item, applicability }
                              : item,
                          ),
                        }))
                      }
                    />
                  </Form.Item>
                </div>
                <Button
                  size="small"
                  danger
                  disabled={disabled}
                  onClick={() =>
                    updateCase(entry.caseId, (old) => ({
                      ...old,
                      criteria: old.criteria.filter(
                        (item) => item.criterionId !== criterion.criterionId,
                      ),
                    }))
                  }
                >
                  Remove criterion
                </Button>
              </div>
            ))}
            <div className="evaluation-subheading">
              <Typography.Text strong>Expected findings</Typography.Text>
              <Tag>{entry.findings.expected.length} findings</Tag>
            </div>
            <Form.Item label="Annotation completeness">
              <Select
                value={entry.findings.annotation}
                options={[
                  {
                    value: "unlabeled",
                    label: "Unlabeled",
                    disabled: entry.findings.expected.length > 0,
                  },
                  { value: "partial", label: "Partial: known positives only" },
                  { value: "complete", label: "Complete: exhaustive findings" },
                ]}
                onChange={(annotation) =>
                  updateCase(entry.caseId, (old) => ({
                    ...old,
                    findings: changeAnnotation(old.findings, annotation),
                  }))
                }
              />
            </Form.Item>
            <Alert
              type="info"
              showIcon
              title={
                entry.findings.annotation === "complete"
                  ? entry.findings.expected.length
                    ? "This list declares every expected finding"
                    : "Complete with zero findings is an explicit negative example"
                  : entry.findings.annotation === "partial"
                    ? "Only the listed known positives are labeled"
                    : "No finding-quality expectation has been declared"
              }
              description={
                entry.findings.annotation === "unlabeled"
                  ? "Choose Partial or Complete before adding expected findings."
                  : "Unjudged or missing labels must not be interpreted as an empty finding set."
              }
            />
            {entry.findings.expected.map((finding) => (
              <div className="evaluation-finding" key={finding.expectedFindingId}>
                <span className="evaluation-meta">{finding.expectedFindingId}</span>
                <Form.Item label="Expected problem" required>
                  <Input.TextArea
                    value={finding.description}
                    maxLength={2048}
                    autoSize={{ minRows: 2, maxRows: 5 }}
                    onChange={(event) =>
                      updateCase(entry.caseId, (old) =>
                        old.findings.annotation === "unlabeled"
                          ? old
                          : {
                              ...old,
                              findings: {
                                ...old.findings,
                                expected: old.findings.expected.map((item) =>
                                  item.expectedFindingId === finding.expectedFindingId
                                    ? { ...item, description: event.target.value }
                                    : item,
                                ),
                              },
                            },
                      )
                    }
                  />
                </Form.Item>
                <Button
                  size="small"
                  danger
                  disabled={disabled}
                  onClick={() =>
                    updateCase(entry.caseId, (old) =>
                      old.findings.annotation === "unlabeled"
                        ? old
                        : {
                            ...old,
                            findings: {
                              ...old.findings,
                              expected: old.findings.expected.filter(
                                (item) => item.expectedFindingId !== finding.expectedFindingId,
                              ),
                            },
                          },
                    )
                  }
                >
                  Remove finding
                </Button>
              </div>
            ))}
            <Button
              size="small"
              disabled={
                disabled ||
                entry.findings.annotation === "unlabeled" ||
                entry.findings.expected.length >= 64
              }
              onClick={() =>
                updateCase(entry.caseId, (old) =>
                  old.findings.annotation === "unlabeled"
                    ? old
                    : {
                        ...old,
                        findings: {
                          ...old.findings,
                          expected: [
                            ...old.findings.expected,
                            { expectedFindingId: newIdentity(), description: "" },
                          ],
                        },
                      },
                )
              }
            >
              Add expected finding
            </Button>
          </Card>
        ))}
      </div>
    </Form>
  );
}
