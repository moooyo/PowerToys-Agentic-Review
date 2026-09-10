import type * as C from "@agentic-review/contracts";
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  FormControl,
  FormLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
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
      <Stack
        direction="row"
        spacing={1.5}
        sx={{
          alignItems: "center",
          flexWrap: "wrap",
          gap: 1,
        }}
      >
        <Switch
          checked={value.state === "applicable"}
          onChange={(_event, checked) =>
            ((checked) =>
              onChange(
                checked
                  ? {
                      state: "applicable",
                    }
                  : {
                      state: "not_applicable",
                      reason: "",
                    },
              ))(checked)
          }
          slotProps={{
            input: {
              "aria-label": "Applicable",
            },
          }}
        />
        <span>Applicable</span>
      </Stack>
      {value.state === "not_applicable" ? (
        <TextField
          value={value.reason}
          onChange={(event) =>
            onChange({
              state: "not_applicable",
              reason: event.target.value,
            })
          }
          placeholder="Explain why this item is outside the evaluation scope"
          fullWidth
          slotProps={{
            htmlInput: {
              maxLength: 2048,
              "aria-label": "Reason this item is not applicable",
            },
          }}
          multiline
          minRows={1}
          maxRows={4}
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
    <Stack
      disabled={disabled}
      component="fieldset"
      spacing={2}
      sx={{
        border: 0,
        p: 0,
        m: 0,
        minWidth: 0,
      }}
    >
      <TextField
        value={value.name}
        onChange={(event) => {
          if (!disabled)
            onChange({
              ...value,
              name: event.target.value,
            });
        }}
        fullWidth
        label={"Sample set name"}
        required={true}
        disabled={disabled}
        slotProps={{
          htmlInput: {
            maxLength: 128,
          },
        }}
      />
      <TextField
        value={value.description}
        onChange={(event) => {
          if (!disabled)
            onChange({
              ...value,
              description: event.target.value,
            });
        }}
        fullWidth
        label={"Description"}
        disabled={disabled}
        slotProps={{
          htmlInput: {
            maxLength: 2048,
          },
        }}
        multiline
        minRows={2}
        maxRows={5}
      />
      {value.cases.length === 0 ? (
        <Alert severity={"info"}>
          <AlertTitle>{"Add a case from the frozen source library below"}</AlertTitle>
          {"An empty draft can be saved. Publishing requires at least one applicable case."}
        </Alert>
      ) : null}
      <div className="evaluation-case-list">
        {value.cases.map((entry, index) => (
          <Card key={entry.caseId} variant="outlined">
            <CardHeader
              title={
                <CaseSourceLabel
                  sourceId={entry.sourceId}
                  known={sources.find((source) => source.id === entry.sourceId)}
                />
              }
              action={
                <Button
                  disabled={disabled}
                  onClick={() => {
                    if (!disabled)
                      onChange({
                        ...value,
                        cases: value.cases.filter((candidate) => candidate.caseId !== entry.caseId),
                      });
                  }}
                  variant="outlined"
                  color="error"
                >
                  Remove case
                </Button>
              }
              slotProps={{
                title: {
                  variant: "subtitle1",
                  component: "h3",
                },
              }}
            />
            <CardContent>
              <p className="evaluation-meta">
                Case {index + 1} · {entry.caseId}
              </p>
              <TextField
                value={entry.title}
                onChange={(event) =>
                  updateCase(entry.caseId, (old) => ({
                    ...old,
                    title: event.target.value,
                  }))
                }
                fullWidth
                label={"Case title"}
                required={true}
                disabled={disabled}
                slotProps={{
                  htmlInput: {
                    maxLength: 256,
                  },
                }}
              />
              <FormControl
                component="fieldset"
                disabled={disabled}
                sx={{
                  minWidth: 0,
                  mb: 2,
                }}
              >
                <FormLabel component="legend">{"Case applicability"}</FormLabel>
                <ApplicabilityEditor
                  value={entry.applicability}
                  onChange={(applicability) =>
                    updateCase(entry.caseId, (old) => ({
                      ...old,
                      applicability,
                    }))
                  }
                />
              </FormControl>
              <div className="evaluation-subheading">
                <Typography
                  component="span"
                  variant="body2"
                  sx={{
                    fontWeight: 500,
                  }}
                >
                  Expected checks
                </Typography>
                <Button
                  disabled={disabled || entry.criteria.length >= 96}
                  onClick={() =>
                    updateCase(entry.caseId, (old) => ({
                      ...old,
                      criteria: [...old.criteria, newCriterion()],
                    }))
                  }
                  variant="outlined"
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
                  <TextField
                    value={criterion.description}
                    onChange={(event) =>
                      updateCase(entry.caseId, (old) => ({
                        ...old,
                        criteria: old.criteria.map((item) =>
                          item.criterionId === criterion.criterionId
                            ? {
                                ...item,
                                description: event.target.value,
                              }
                            : item,
                        ),
                      }))
                    }
                    fullWidth
                    label={"Criterion"}
                    required={true}
                    disabled={disabled}
                    slotProps={{
                      htmlInput: {
                        maxLength: 2048,
                      },
                    }}
                    multiline
                    minRows={1}
                    maxRows={4}
                  />
                  <div className="evaluation-field-grid">
                    <Autocomplete
                      options={[
                        {
                          value: "passed",
                          label: "Passed",
                        },
                        {
                          value: "failed",
                          label: "Failed",
                        },
                      ]}
                      disablePortal
                      fullWidth
                      disabled={disabled}
                      value={
                        [
                          {
                            value: "passed",
                            label: "Passed",
                          },
                          {
                            value: "failed",
                            label: "Failed",
                          },
                        ].find((option) => option.value === criterion.expectedOutcome) ??
                        (criterion.expectedOutcome == null ||
                        String(criterion.expectedOutcome) === ""
                          ? null
                          : {
                              value: criterion.expectedOutcome as NonNullable<
                                NonNullable<typeof criterion>["expectedOutcome"]
                              >,
                              label: String(criterion.expectedOutcome),
                            })
                      }
                      onChange={(_event, option) => {
                        if (option !== null)
                          ((expectedOutcome) =>
                            updateCase(entry.caseId, (old) => ({
                              ...old,
                              criteria: old.criteria.map((item) =>
                                item.criterionId === criterion.criterionId
                                  ? {
                                      ...item,
                                      expectedOutcome,
                                    }
                                  : item,
                              ),
                            })))(
                            option.value as NonNullable<
                              NonNullable<typeof criterion>["expectedOutcome"]
                            >,
                          );
                      }}
                      getOptionLabel={(option) => option.label}
                      isOptionEqualToValue={(option, selected) => option.value === selected.value}
                      getOptionDisabled={(option) =>
                        "disabled" in option && option.disabled === true
                      }
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          label={"Expected outcome"}
                          slotProps={{
                            ...params.slotProps,
                            htmlInput: {
                              ...params.slotProps.htmlInput,
                              "aria-label": "Expected outcome",
                            },
                          }}
                        />
                      )}
                      disableClearable={Boolean(criterion.expectedOutcome)}
                      getOptionKey={(option) => option.value}
                    />
                    <FormControl
                      component="fieldset"
                      disabled={disabled}
                      sx={{
                        minWidth: 0,
                        mb: 2,
                      }}
                    >
                      <FormLabel component="legend">{"Criterion applicability"}</FormLabel>
                      <ApplicabilityEditor
                        value={criterion.applicability}
                        onChange={(applicability) =>
                          updateCase(entry.caseId, (old) => ({
                            ...old,
                            criteria: old.criteria.map((item) =>
                              item.criterionId === criterion.criterionId
                                ? {
                                    ...item,
                                    applicability,
                                  }
                                : item,
                            ),
                          }))
                        }
                      />
                    </FormControl>
                  </div>
                  <Button
                    disabled={disabled}
                    onClick={() =>
                      updateCase(entry.caseId, (old) => ({
                        ...old,
                        criteria: old.criteria.filter(
                          (item) => item.criterionId !== criterion.criterionId,
                        ),
                      }))
                    }
                    variant="outlined"
                    color="error"
                  >
                    Remove criterion
                  </Button>
                </div>
              ))}
              <div className="evaluation-subheading">
                <Typography
                  component="span"
                  variant="body2"
                  sx={{
                    fontWeight: 500,
                  }}
                >
                  Expected findings
                </Typography>
                <Chip label={<>{entry.findings.expected.length} findings</>} />
              </div>
              <Autocomplete
                options={[
                  {
                    value: "unlabeled",
                    label: "Unlabeled",
                    disabled: entry.findings.expected.length > 0,
                  },
                  {
                    value: "partial",
                    label: "Partial: known positives only",
                  },
                  {
                    value: "complete",
                    label: "Complete: exhaustive findings",
                  },
                ]}
                disablePortal
                fullWidth
                disabled={disabled}
                value={
                  [
                    {
                      value: "unlabeled",
                      label: "Unlabeled",
                      disabled: entry.findings.expected.length > 0,
                    },
                    {
                      value: "partial",
                      label: "Partial: known positives only",
                    },
                    {
                      value: "complete",
                      label: "Complete: exhaustive findings",
                    },
                  ].find((option) => option.value === entry.findings.annotation) ??
                  (entry.findings.annotation == null || String(entry.findings.annotation) === ""
                    ? null
                    : {
                        value: entry.findings.annotation as NonNullable<
                          NonNullable<NonNullable<typeof entry>["findings"]>["annotation"]
                        >,
                        label: String(entry.findings.annotation),
                      })
                }
                onChange={(_event, option) => {
                  if (option !== null)
                    ((annotation) =>
                      updateCase(entry.caseId, (old) => ({
                        ...old,
                        findings: changeAnnotation(old.findings, annotation),
                      })))(
                      option.value as NonNullable<
                        NonNullable<NonNullable<typeof entry>["findings"]>["annotation"]
                      >,
                    );
                }}
                getOptionLabel={(option) => option.label}
                isOptionEqualToValue={(option, selected) => option.value === selected.value}
                getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label={"Annotation completeness"}
                    slotProps={{
                      ...params.slotProps,
                      htmlInput: {
                        ...params.slotProps.htmlInput,
                        "aria-label": "Annotation completeness",
                      },
                    }}
                  />
                )}
                disableClearable={Boolean(entry.findings.annotation)}
                getOptionKey={(option) => option.value}
              />
              <Alert severity={"info"}>
                <AlertTitle>
                  {entry.findings.annotation === "complete"
                    ? entry.findings.expected.length
                      ? "This list declares every expected finding"
                      : "Complete with zero findings is an explicit negative example"
                    : entry.findings.annotation === "partial"
                      ? "Only the listed known positives are labeled"
                      : "No finding-quality expectation has been declared"}
                </AlertTitle>
                {entry.findings.annotation === "unlabeled"
                  ? "Choose Partial or Complete before adding expected findings."
                  : "Unjudged or missing labels must not be interpreted as an empty finding set."}
              </Alert>
              {entry.findings.expected.map((finding) => (
                <div className="evaluation-finding" key={finding.expectedFindingId}>
                  <span className="evaluation-meta">{finding.expectedFindingId}</span>
                  <TextField
                    value={finding.description}
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
                                    ? {
                                        ...item,
                                        description: event.target.value,
                                      }
                                    : item,
                                ),
                              },
                            },
                      )
                    }
                    fullWidth
                    label={"Expected problem"}
                    required={true}
                    disabled={disabled}
                    slotProps={{
                      htmlInput: {
                        maxLength: 2048,
                      },
                    }}
                    multiline
                    minRows={2}
                    maxRows={5}
                  />
                  <Button
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
                    variant="outlined"
                    color="error"
                  >
                    Remove finding
                  </Button>
                </div>
              ))}
              <Button
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
                              {
                                expectedFindingId: newIdentity(),
                                description: "",
                              },
                            ],
                          },
                        },
                  )
                }
                variant="outlined"
              >
                Add expected finding
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </Stack>
  );
}
