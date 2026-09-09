import type {
  DashboardReviewRunReproductionCaseResponse,
  IssueReproductionCaseAssessment,
  ObservationValue,
  ReproductionObservationFact,
  ReproductionObservationRef,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { sampleReviewRunResults } from "../../services/runs/fixtures";
import {
  observationFactLabel,
  observationRefKey,
  observationRefLabel,
  observationValueLabel,
  reproductionCaseMatches,
  reproductionCasePresentation,
  reproductionConclusionPresentation,
  reproductionEvidenceScope,
  reproductionPollingInterval,
  reproductionQueryKey,
  reproductionTargetLabel,
  type ReproductionCaseSelection,
} from "./state";

const result = sampleReviewRunResults.find((entry) => entry.report.workItemKind === "issue");
if (!result) throw new Error("An issue sample result is required.");

const principal = { issuer: "https://issuer.example/tenant", subject: "Reviewer" };
const selection: ReproductionCaseSelection = {
  repositoryId: result.repositoryId,
  workItemId: result.workItemId,
  reviewRunId: result.reviewRunId,
  requestId: result.requestId,
  caseId: "case-one",
  jobId: result.jobId,
  resultId: result.id,
  bindingDigest: "a".repeat(64),
  planDigest: result.planDigest,
  issueRevisionKey: result.revisionKey,
  testedSourceCommit: "b".repeat(40),
  profileVersionId: result.profileVersionId,
  target: "windows_desktop",
};
const reference: ReproductionObservationRef = {
  kind: "probe_value",
  testStepId: "measure",
  observationId: "count",
};
const recorded: IssueReproductionCaseAssessment = {
  caseId: selection.caseId,
  requestId: selection.requestId,
  profileVersionId: selection.profileVersionId,
  target: selection.target,
  state: "present",
  matchedObservationRefs: [reference],
  evidenceIds: ["evidence-one"],
  reasons: [],
};
const detail: DashboardReviewRunReproductionCaseResponse = {
  repositoryId: selection.repositoryId,
  reviewRunId: selection.reviewRunId,
  requestId: selection.requestId,
  caseId: selection.caseId,
  jobId: result.jobId,
  resultId: result.id,
  bindingDigest: selection.bindingDigest,
  planDigest: selection.planDigest,
  binding: {
    schemaVersion: "IssueReproductionBindingV1",
    activationId: "activation-one",
    repositoryId: selection.repositoryId,
    githubRepositoryId: 1,
    workItemId: selection.workItemId,
    githubWorkItemId: 2,
    issueRevisionKey: selection.issueRevisionKey,
    testedSourceCommit: selection.testedSourceCommit,
    authorizedBy: {
      ...principal,
      authorizedAt: "2026-09-07T01:00:00.000Z",
    },
    claim: "Saving once creates two records.",
  },
  case: {
    id: selection.caseId,
    requestId: selection.requestId,
    profileVersionId: selection.profileVersionId,
    profileConfigSha256: "c".repeat(64),
    target: selection.target,
    context: "Measure the record count after one save.",
    preconditions: [],
    presentWhen: {
      allOf: [{ observation: reference, equals: { type: "number", value: 2 } }],
    },
    absentWhen: null,
  },
  current: recorded,
  recorded,
  observations: [
    {
      observation: reference,
      checkId: "measure:count",
      evidenceIds: ["evidence-one"],
      state: "observed",
      value: { type: "number", value: 2 },
    },
  ],
};

describe("reproduction facts and target labels", () => {
  it.each([
    [{ type: "boolean", value: false }, "boolean · false"],
    [{ type: "number", value: 0 }, "number · 0"],
    [{ type: "string", value: "" }, 'string · ""'],
  ] satisfies [ObservationValue, string][])(
    "preserves the typed false-like value %j",
    (value, label) => {
      const fact: ReproductionObservationFact = {
        observation: reference,
        checkId: "measure:count",
        evidenceIds: [],
        state: "observed",
        value,
      };
      expect(observationValueLabel(value)).toBe(label);
      expect(observationFactLabel(fact)).toBe(label);
    },
  );

  it("keeps missing and unavailable facts distinct from an absent issue", () => {
    expect(observationFactLabel(undefined)).toBe("Not observed");
    expect(
      observationFactLabel({
        observation: reference,
        checkId: "measure:count",
        evidenceIds: [],
        state: "unavailable",
        reason: "capture_failed",
      }),
    ).toBe("Unavailable · capture failed");
    expect(reproductionCasePresentation(undefined)).toEqual({
      label: "Not recorded",
      tone: "default",
    });
    expect(reproductionCasePresentation(null)).toEqual({
      label: "Not recorded",
      tone: "default",
    });
    expect(
      reproductionCasePresentation({
        ...recorded,
        state: "inconclusive",
        reasons: ["observation_unavailable"],
      }),
    ).toEqual({ label: "Inconclusive", tone: "default" });
  });

  it.each([
    ["windows_desktop", "Windows UI"],
    ["web", "Web UI"],
    ["headless", "Headless"],
  ] as const)("identifies the %s execution target", (target, label) => {
    expect(reproductionTargetLabel[target]).toBe(label);
  });

  it("identifies both observation kinds without combining neighboring tuple fields", () => {
    const ui: ReproductionObservationRef = {
      kind: "ui_assertion",
      scenarioId: "focus",
      stepId: "restore",
    };
    expect(observationRefLabel(ui)).toBe("UI assertion · focus / restore");
    expect(observationRefLabel(reference)).toBe("Probe value · measure / count");
    expect(observationRefKey(ui)).not.toBe(
      observationRefKey({ kind: "probe_value", testStepId: "focus", observationId: "restore" }),
    );
    expect(observationRefKey({ ...ui, scenarioId: "focus/restore", stepId: "check" })).not.toBe(
      observationRefKey({ ...ui, scenarioId: "focus", stepId: "restore/check" }),
    );
    expect(
      observationRefKey({ ...reference, testStepId: "measure/count", observationId: "check" }),
    ).not.toBe(
      observationRefKey({ ...reference, testStepId: "measure", observationId: "count/check" }),
    );
  });
});

describe("current assessment and recorded conclusion", () => {
  it.each([
    ["present", "Present", "warning"],
    ["absent", "Absent", "success"],
    ["blocked", "Blocked", "warning"],
    ["inconclusive", "Inconclusive", "default"],
  ] as const)("preserves the explicit %s case assessment", (state, label, tone) => {
    expect(reproductionCasePresentation({ ...recorded, state })).toEqual({ label, tone });
  });

  it.each([
    ["confirmed", "Confirmed", "warning"],
    ["not_reproduced", "Not reproduced", "success"],
    ["blocked", "Blocked", "warning"],
    ["inconclusive", "Inconclusive", "default"],
  ] as const)("preserves the explicit %s run conclusion", (conclusion, label, tone) => {
    expect(reproductionConclusionPresentation({ conclusion, cases: [recorded] })).toEqual({
      label,
      tone,
    });
  });

  it.each([
    ["invalid_scope", "Historical · not current", "default"],
    ["execution_pending", "Pending", "processing"],
  ] as const)(
    "qualifies a current positive conclusion with %s while retaining its recorded result",
    (reason, label, tone) => {
      const current = { ...recorded, reasons: [reason] };
      const assessment = { conclusion: "confirmed" as const, cases: [current] };
      expect(reproductionCasePresentation(current)).toEqual({ label, tone });
      expect(reproductionConclusionPresentation(assessment)).toEqual({ label, tone });
      expect(reproductionCasePresentation(current, false)).toEqual({
        label: "Present",
        tone: "warning",
      });
      expect(reproductionConclusionPresentation(assessment, false)).toEqual({
        label: "Confirmed",
        tone: "warning",
      });
    },
  );

  it("keeps a blocked current assessment separate from previously recorded positive evidence", () => {
    const current: IssueReproductionCaseAssessment = {
      ...recorded,
      state: "blocked",
      reasons: ["evidence_unavailable"],
    };
    expect(reproductionCasePresentation(current)).toEqual({ label: "Blocked", tone: "warning" });
    expect(reproductionConclusionPresentation({ conclusion: "blocked", cases: [current] })).toEqual(
      {
        label: "Blocked",
        tone: "warning",
      },
    );
    expect(reproductionCasePresentation(recorded, false)).toEqual({
      label: "Present",
      tone: "warning",
    });
    expect(
      reproductionConclusionPresentation({ conclusion: "confirmed", cases: [recorded] }, false),
    ).toEqual({ label: "Confirmed", tone: "warning" });
  });

  it("does not label a mixed current assessment entirely pending or historical", () => {
    for (const reason of ["execution_pending", "invalid_scope"] as const) {
      expect(
        reproductionConclusionPresentation({
          conclusion: "inconclusive",
          cases: [{ ...recorded, state: "inconclusive", reasons: [reason] }, recorded],
        }),
      ).toEqual({ label: "Inconclusive", tone: "default" });
    }
  });
});

describe("reproduction case scope and session identity", () => {
  it("matches the selected immutable case with or without a recorded assessment", () => {
    expect(reproductionCaseMatches(detail, selection)).toBe(true);
    expect(reproductionCaseMatches({ ...detail, recorded: null }, selection)).toBe(true);
  });

  it.each([
    "repositoryId",
    "workItemId",
    "reviewRunId",
    "requestId",
    "caseId",
    "jobId",
    "resultId",
    "bindingDigest",
    "planDigest",
    "issueRevisionKey",
    "testedSourceCommit",
    "profileVersionId",
    "target",
  ] as const)("rejects a different selected %s and isolates its query cache", (field) => {
    const changed: ReproductionCaseSelection = {
      ...selection,
      [field]: field === "target" ? "web" : "different",
    };
    expect(reproductionCaseMatches(detail, changed)).toBe(false);
    expect(reproductionQueryKey("connected", changed, principal, "session-one")).not.toEqual(
      reproductionQueryKey("connected", selection, principal, "session-one"),
    );
  });

  it.each([
    "repositoryId",
    "reviewRunId",
    "requestId",
    "caseId",
    "jobId",
    "resultId",
    "bindingDigest",
    "planDigest",
  ] as const)("rejects a different response envelope %s", (field) => {
    expect(reproductionCaseMatches({ ...detail, [field]: "different" }, selection)).toBe(false);
  });

  it.each(["repositoryId", "workItemId", "issueRevisionKey", "testedSourceCommit"] as const)(
    "rejects a different frozen binding %s even when the response envelope matches",
    (field) => {
      expect(
        reproductionCaseMatches(
          { ...detail, binding: { ...detail.binding, [field]: "different" } },
          selection,
        ),
      ).toBe(false);
    },
  );

  it.each(["id", "requestId", "profileVersionId", "target"] as const)(
    "rejects a different frozen case %s even when the response envelope matches",
    (field) => {
      expect(
        reproductionCaseMatches(
          {
            ...detail,
            case: { ...detail.case, [field]: field === "target" ? "web" : "different" },
          },
          selection,
        ),
      ).toBe(false);
    },
  );

  it.each(["caseId", "requestId", "profileVersionId", "target"] as const)(
    "rejects a neighboring current or recorded assessment %s",
    (field) => {
      for (const assessment of ["current", "recorded"] as const) {
        expect(
          reproductionCaseMatches(
            {
              ...detail,
              [assessment]: { ...recorded, [field]: field === "target" ? "web" : "different" },
            },
            selection,
          ),
        ).toBe(false);
      }
    },
  );

  it("allows an unpinned latest selection but never treats it as the same pinned query", () => {
    const latest = { ...selection, jobId: undefined, resultId: undefined };
    const response = { ...detail, jobId: "new-job", resultId: "new-result" };
    expect(reproductionCaseMatches(response, latest)).toBe(true);
    expect(reproductionCaseMatches(response, selection)).toBe(false);
    expect(reproductionQueryKey("connected", latest, principal, "session-one")).not.toEqual(
      reproductionQueryKey("connected", selection, principal, "session-one"),
    );
    expect(
      reproductionCaseMatches({ ...detail, jobId: null, resultId: null, recorded: null }, latest),
    ).toBe(true);
  });

  it("isolates sample mode, exact principal identity, and renewed access sessions", () => {
    const key = reproductionQueryKey("connected", selection, principal, "session-one");
    expect(reproductionQueryKey("sample", selection, principal, "session-one")).not.toEqual(key);
    expect(
      reproductionQueryKey(
        "connected",
        selection,
        { ...principal, issuer: "https://ISSUER.example/tenant" },
        "session-one",
      ),
    ).not.toEqual(key);
    expect(
      reproductionQueryKey(
        "connected",
        selection,
        { ...principal, subject: "reviewer" },
        "session-one",
      ),
    ).not.toEqual(key);
    expect(reproductionQueryKey("connected", selection, principal, "session-two")).not.toEqual(key);
    expect(
      reproductionQueryKey(
        "connected",
        { ...selection, executionKey: "execution-refreshed" },
        principal,
        "session-one",
      ),
    ).not.toEqual(key);
    expect(
      reproductionQueryKey("connected", { ...selection }, { ...principal }, "session-one"),
    ).toEqual(key);
  });
});

describe("reproduction evidence result scope", () => {
  it("uses the exact matched result and its execution attempt to scope evidence reads", () => {
    expect(reproductionEvidenceScope(detail, result)).toEqual({
      repositoryId: result.repositoryId,
      runId: result.reviewRunId,
      jobId: result.jobId,
      runAttemptId: result.runAttemptId,
      requestId: result.requestId,
      profileVersionId: result.profileVersionId,
      revisionKey: result.revisionKey,
      planDigest: result.planDigest,
    });
  });

  it.each([
    "repositoryId",
    "workItemId",
    "reviewRunId",
    "requestId",
    "jobId",
    "id",
    "profileVersionId",
    "revisionKey",
    "planDigest",
  ] as const)("rejects evidence from a result with a different %s", (field) => {
    expect(reproductionEvidenceScope(detail, { ...result, [field]: "different" })).toBeNull();
  });

  it("withholds evidence when no exact result is available or the detail is still pending", () => {
    expect(reproductionEvidenceScope(detail, undefined)).toBeNull();
    expect(reproductionEvidenceScope(detail, null)).toBeNull();
    expect(
      reproductionEvidenceScope({ ...detail, jobId: null, resultId: null, recorded: null }, result),
    ).toBeNull();
    const pullRequest = sampleReviewRunResults.find(
      (entry) => entry.report.workItemKind === "pull_request",
    );
    if (!pullRequest) throw new Error("A pull request sample result is required.");
    expect(reproductionEvidenceScope(detail, { ...result, report: pullRequest.report })).toBeNull();
  });

  it("allows inspection of recorded evidence after the result becomes nonauthoritative and historical", () => {
    const historical: DashboardReviewRunReproductionCaseResponse = {
      ...detail,
      current: { ...recorded, state: "inconclusive", reasons: ["invalid_scope"] },
    };
    expect(reproductionCaseMatches(historical, selection)).toBe(true);
    expect(reproductionCasePresentation(historical.current).label).toBe("Historical · not current");
    expect(reproductionCasePresentation(historical.recorded, false).label).toBe("Present");
    expect(reproductionEvidenceScope(historical, { ...result, authoritative: false })).toEqual(
      reproductionEvidenceScope(detail, result),
    );
  });
});

describe("reproduction live refresh", () => {
  it("polls every 30 seconds only for visible, authorized, successful connected reads", () => {
    const active = { mode: "connected" as const, visible: true, canRead: true, hasError: false };
    expect(reproductionPollingInterval(active)).toBe(30_000);
    expect(reproductionPollingInterval({ ...active, mode: "sample" })).toBe(false);
    expect(reproductionPollingInterval({ ...active, visible: false })).toBe(false);
    expect(reproductionPollingInterval({ ...active, canRead: false })).toBe(false);
    expect(reproductionPollingInterval({ ...active, hasError: true })).toBe(false);
  });
});
