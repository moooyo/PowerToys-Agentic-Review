import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterAll, describe, expect, it } from "vitest";
import {
  type EvaluationAdjudicationChangeRequest,
  type EvaluationAdjudicationChangeV1,
  EvaluationAdjudicationChangeV1Schema,
  type EvaluationAdjudicationContextV1,
  EvaluationAdjudicationContextV1Schema,
  type EvaluationAdjudicationHistoryV1,
  EvaluationAdjudicationHistoryV1Schema,
  type EvaluationAdjudicationScope,
  getEvaluationAdjudicationChangeIssues,
  getEvaluationAdjudicationChangeRequestIssues,
  getEvaluationAdjudicationContextIssues,
  getEvaluationAdjudicationHistoryIssues,
  getEvaluationAdjudicationHistoryQueryIssues,
  getEvaluationAdjudicationScopeIssues,
  maximumEvaluationAdjudicationChangeUtf8Bytes,
  maximumEvaluationAdjudicationReadUtf8Bytes,
} from "./evaluation-adjudication.js";
import type { EvaluationCellResultReadQuery } from "./evaluation-results.js";
import type { EvaluationFindingAdjudication } from "./evaluation-scoring.js";
import { maximumFindingResultOccurrenceCount } from "./finding-dispositions.js";

const now = "2026-09-08T01:00:00.000Z";
const digest = "a".repeat(64);
const actor = { issuer: "https://identity.example", subject: "reviewer-1" };
const originalDateTime = FormatRegistry.Get("date-time");
afterAll(() => {
  if (originalDateTime === undefined) FormatRegistry.Delete("date-time");
  else FormatRegistry.Set("date-time", originalDateTime);
});
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("The fixture entry is missing.");
  return value;
}
const key = (index: number) => (index + 1).toString(16).padStart(64, "0");
function resultScope(): EvaluationCellResultReadQuery {
  return {
    repositoryId: "repository-1",
    evaluationId: "evaluation-1",
    cellId: "cell-baseline",
    resultId: "result-1",
  };
}
function scope(): EvaluationAdjudicationScope {
  return { ...resultScope(), occurrenceKey: key(0) };
}
function adjudication(version = 1): EvaluationFindingAdjudication {
  return {
    adjudicationId: `event-${version}`,
    caseId: "case-1",
    arm: "baseline",
    resultId: "result-1",
    resultDigest: digest,
    occurrenceKey: key(0),
    kind: "false_positive",
    reason: "The reviewer compared this finding with the frozen example.",
    actor: { ...actor },
    createdAt: now,
  };
}
function context(count = 2): EvaluationAdjudicationContextV1 {
  const value: EvaluationAdjudicationContextV1 = {
    schemaVersion: "EvaluationAdjudicationContextV1",
    scope: resultScope(),
    resultDigest: digest,
    caseId: "case-1",
    arm: "baseline",
    modelRequired: true,
    modelState: "completed",
    expectations: {
      annotation: "complete",
      expected: [
        { expectedFindingId: "expected-1", description: "The known regression is detected." },
      ],
    },
    items: Array.from({ length: count }, (_, index) => ({
      occurrence: {
        key: key(index),
        resultId: "result-1",
        resultDigest: digest,
        kind: index < 100 ? "pr_finding" : "validation_observation",
        ordinal: index % 100,
      },
      version: 0,
      adjudication: null,
    })),
  };
  const first = value.items[0];
  if (first) {
    first.version = 1;
    first.adjudication = { ...adjudication(), kind: "match", expectedFindingId: "expected-1" };
  }
  return value;
}
function request(): EvaluationAdjudicationChangeRequest {
  return {
    changeId: "change-1",
    expectedVersion: 1,
    resultDigest: digest,
    judgment: {
      kind: "match",
      expectedFindingId: "expected-1",
      reason: "This matches the frozen regression.",
    },
  };
}
function change(): EvaluationAdjudicationChangeV1 {
  return {
    schemaVersion: "EvaluationAdjudicationChangeV1",
    scope: scope(),
    previousVersion: 1,
    version: 2,
    adjudication: adjudication(2),
  };
}
function history(page = 1, pageSize = 2, total = 3): EvaluationAdjudicationHistoryV1 {
  const offset = (page - 1) * pageSize;
  return {
    schemaVersion: "EvaluationAdjudicationHistoryV1",
    scope: scope(),
    resultDigest: digest,
    page,
    pageSize,
    total,
    items: Array.from({ length: Math.min(pageSize, Math.max(0, total - offset)) }, (_, index) => {
      const version = total - offset - index;
      return {
        version,
        previousEventId: version === 1 ? null : `event-${version - 1}`,
        adjudication: adjudication(version),
      };
    }),
  };
}
function appendAtPath(value: object, path: string, suffix: string): void {
  const fields = path.split(".");
  const field = required(fields.pop());
  const target = fields.reduce(
    (entry, name) => entry[name] as Record<string, unknown>,
    value as Record<string, unknown>,
  );
  if (typeof target[field] !== "string") throw new Error("The fixture identity is not a string.");
  target[field] += suffix;
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

function contextAtByteLimit(): EvaluationAdjudicationContextV1 {
  const value = context(maximumFindingResultOccurrenceCount);
  for (const [index, item] of value.items.entries()) {
    item.version = 1;
    item.adjudication = {
      ...adjudication(index + 1),
      occurrenceKey: item.occurrence.key,
      reason: "r",
      actor: { issuer: "i", subject: "s" },
    };
  }
  let remaining = maximumEvaluationAdjudicationReadUtf8Bytes - bytes(value);
  const fill = (current: string, maximum: number): string => {
    const multibyte = Math.min(maximum - current.length, Math.floor(remaining / 3));
    remaining -= multibyte * 3;
    const ascii = Math.min(maximum - current.length - multibyte, remaining);
    remaining -= ascii;
    return `${current}${"雪".repeat(multibyte)}${"x".repeat(ascii)}`;
  };
  for (const item of value.items) {
    const entry = required(item.adjudication);
    entry.reason = fill(entry.reason, 2048);
    entry.actor.issuer = fill(entry.actor.issuer, 2048);
    entry.actor.subject = fill(entry.actor.subject, 512);
  }
  if (remaining !== 0) throw new Error("The fixture could not fill the context byte budget.");
  return value;
}

describe("evaluation adjudication selection and change request", () => {
  it("keeps the occurrence selector in its exact path scope", () => {
    expect(getEvaluationAdjudicationScopeIssues(scope())).toEqual([]);
    for (const field of Object.keys(scope())) {
      const missing: Record<string, unknown> = scope();
      delete missing[field];
      expect(getEvaluationAdjudicationScopeIssues(missing).length, field).toBeGreaterThan(0);
    }
    for (const extra of [{ actor }, { expectedVersion: 1 }, { judgment: request().judgment }])
      expect(getEvaluationAdjudicationScopeIssues({ ...scope(), ...extra }).length).toBeGreaterThan(
        0,
      );
    expect(
      getEvaluationAdjudicationScopeIssues({ ...scope(), occurrenceKey: "A".repeat(64) }).length,
    ).toBeGreaterThan(0);
  });

  it("supports each explicit judgment without inferring one from model confidence", () => {
    for (const judgment of [
      { kind: "match", expectedFindingId: "expected:part-1", reason: "Matched manually." },
      {
        kind: "duplicate",
        primaryOccurrenceKey: key(1),
        reason: "The reviewer selected the primary match.",
      },
      { kind: "false_positive", reason: "The finding is incorrect for this example." },
      {
        kind: "unjudged",
        reason: "Reopen the finding for another review.\nPreserve this explanation.",
      },
    ] as const) {
      const value = { ...request(), judgment };
      const original = structuredClone(value);
      expect(getEvaluationAdjudicationChangeRequestIssues(value)).toEqual([]);
      expect(value).toEqual(original);
    }
    for (const judgment of [
      { kind: "match", reason: "Missing expected identity." },
      { kind: "duplicate", reason: "Missing primary identity." },
      { kind: "false_positive", reason: "r", expectedFindingId: "expected-1" },
      { kind: "unjudged", reason: "r", primaryOccurrenceKey: key(1) },
      { kind: "true_positive", reason: "Do not infer labels." },
      { kind: "match", expectedFindingId: "expected-1", reason: "r", confidence: 0.9 },
    ])
      expect(
        getEvaluationAdjudicationChangeRequestIssues({ ...request(), judgment }).length,
      ).toBeGreaterThan(0);
  });

  it("requires a bounded human explanation and explicit compare-and-swap version", () => {
    for (const reason of ["", " \n\t", "bad\0reason", "x".repeat(2049)])
      expect(
        getEvaluationAdjudicationChangeRequestIssues({
          ...request(),
          judgment: { kind: "unjudged", reason },
        }).length,
      ).toBeGreaterThan(0);
    for (const expectedVersion of [undefined, -1, 0.5, "1", Number.MAX_SAFE_INTEGER])
      expect(
        getEvaluationAdjudicationChangeRequestIssues({ ...request(), expectedVersion }).length,
      ).toBeGreaterThan(0);
    for (const expectedVersion of [0, Number.MAX_SAFE_INTEGER - 1])
      expect(
        getEvaluationAdjudicationChangeRequestIssues({ ...request(), expectedVersion }),
      ).toEqual([]);
  });

  it.each([
    "scope",
    "occurrenceKey",
    "caseId",
    "arm",
    "actor",
    "adjudicationId",
    "createdAt",
    "version",
    "replayOnly",
    "modelState",
    "modelRequired",
  ])("rejects client-owned scope or audit facts in the body: %s", (field) => {
    expect(
      getEvaluationAdjudicationChangeRequestIssues({ ...request(), [field]: true }).length,
    ).toBeGreaterThan(0);
  });
});

describe("evaluation adjudication context", () => {
  it("keeps null version-zero entries, current judgments, and frozen labels without mutation", () => {
    const value = context();
    const original = structuredClone(value);
    expect(getEvaluationAdjudicationContextIssues(value)).toEqual([]);
    expect(value).toEqual(original);
    expect(getEvaluationAdjudicationContextIssues(context(0))).toEqual([]);
    expect(
      getEvaluationAdjudicationContextIssues(context(maximumFindingResultOccurrenceCount)),
    ).toEqual([]);
    expect(
      getEvaluationAdjudicationContextIssues(context(maximumFindingResultOccurrenceCount + 1))
        .length,
    ).toBeGreaterThan(0);
    for (const annotation of ["complete", "partial", "unlabeled"] as const)
      expect(
        getEvaluationAdjudicationContextIssues({
          ...context(),
          expectations: { annotation, expected: [] },
        }),
      ).toEqual([]);
  });

  it("preserves model requirement and state independently of UI write eligibility", () => {
    for (const modelRequired of [true, false])
      for (const modelState of ["completed", "failed", "not_requested"] as const)
        expect(
          getEvaluationAdjudicationContextIssues({ ...context(), modelRequired, modelState }),
        ).toEqual([]);
    for (const extra of [
      { eligible: true },
      { evidenceVerified: true },
      { cli: { kind: "codex", version: "1.0.0", requestedModel: null } },
      { truePositive: true },
    ])
      expect(
        getEvaluationAdjudicationContextIssues({ ...context(), ...extra }).length,
      ).toBeGreaterThan(0);
  });

  it("allows the final safe current version while forbidding a non-null zero-version judgment", () => {
    const value = context();
    required(value.items[0]).version = Number.MAX_SAFE_INTEGER;
    expect(getEvaluationAdjudicationContextIssues(value)).toEqual([]);
    required(value.items[0]).version = 0;
    expect(getEvaluationAdjudicationContextIssues(value).length).toBeGreaterThan(0);
    const missing = context();
    required(missing.items[1]).version = 1;
    expect(getEvaluationAdjudicationContextIssues(missing).length).toBeGreaterThan(0);
  });

  it("rejects repeated occurrence hashes and kind-local ordinals while preserving the two kind namespaces", () => {
    const value = context();
    required(value.items[1]).occurrence.ordinal = 0;
    expect(getEvaluationAdjudicationContextIssues(value).length).toBeGreaterThan(0);
    required(value.items[1]).occurrence.kind = "validation_observation";
    expect(getEvaluationAdjudicationContextIssues(value)).toEqual([]);
    required(value.items[1]).occurrence.key = required(value.items[0]).occurrence.key;
    expect(getEvaluationAdjudicationContextIssues(value).length).toBeGreaterThan(0);
  });

  it.each(["caseId", "arm", "resultId", "resultDigest", "occurrenceKey"] as const)(
    "rejects a current adjudication with a different %s",
    (field) => {
      const value = context();
      const selected = required(required(value.items[0]).adjudication);
      const replacements = {
        caseId: "other-case",
        arm: "candidate",
        resultId: "other-result",
        resultDigest: "b".repeat(64),
        occurrenceKey: key(5),
      };
      Object.assign(selected, { [field]: replacements[field] });
      expect(Value.Check(EvaluationAdjudicationContextV1Schema, value)).toBe(true);
      expect(getEvaluationAdjudicationContextIssues(value).length).toBeGreaterThan(0);
    },
  );

  it("rejects foreign occurrence results, repeated current event IDs, and ambiguous frozen expectation IDs", () => {
    const mutations: ((value: EvaluationAdjudicationContextV1) => void)[] = [
      (value) => {
        required(value.items[1]).occurrence.resultId = "other-result";
      },
      (value) => {
        required(value.items[1]).occurrence.resultDigest = "b".repeat(64);
      },
      (value) => {
        const second = required(value.items[1]);
        second.version = 1;
        second.adjudication = { ...adjudication(), occurrenceKey: second.occurrence.key };
      },
      (value) => {
        if (value.expectations.annotation !== "unlabeled")
          value.expectations.expected.push({ ...required(value.expectations.expected[0]) });
      },
    ];
    for (const mutate of mutations) {
      const value = context();
      mutate(value);
      expect(Value.Check(EvaluationAdjudicationContextV1Schema, value)).toBe(true);
      expect(getEvaluationAdjudicationContextIssues(value).length).toBeGreaterThan(0);
    }
  });

  it("leaves actual model membership and whole-current-set match or duplicate consistency to the owner", () => {
    const value = context();
    required(value.items[0]).adjudication = {
      ...adjudication(),
      kind: "match",
      expectedFindingId: "owner-must-check-membership",
    };
    expect(getEvaluationAdjudicationContextIssues(value)).toEqual([]);
    required(value.items[0]).adjudication = {
      ...adjudication(),
      kind: "duplicate",
      primaryOccurrenceKey: key(99),
    };
    expect(getEvaluationAdjudicationContextIssues(value)).toEqual([]);
  });
});

describe("accepted adjudication changes and append-only history", () => {
  it("advances exactly one version and binds the accepted event to the selected result occurrence", () => {
    expect(getEvaluationAdjudicationChangeIssues(change())).toEqual([]);
    expect(
      getEvaluationAdjudicationChangeIssues({
        ...change(),
        previousVersion: Number.MAX_SAFE_INTEGER - 1,
        version: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual([]);
    for (const patch of [
      { previousVersion: 2 },
      { version: 3 },
      { version: 0 },
      { version: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(
        getEvaluationAdjudicationChangeIssues({ ...change(), ...patch }).length,
      ).toBeGreaterThan(0);
    for (const patch of [{ resultId: "other-result" }, { occurrenceKey: key(10) }])
      expect(
        getEvaluationAdjudicationChangeIssues({
          ...change(),
          adjudication: { ...adjudication(), ...patch },
        }).length,
      ).toBeGreaterThan(0);
  });

  it("supports exact complete history windows, including an empty page and safe extreme offsets", () => {
    for (const value of [
      history(),
      history(2),
      history(3),
      history(1, 20, 0),
      history(1, 50, 50),
      history(Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
    ])
      expect(getEvaluationAdjudicationHistoryIssues(value)).toEqual([]);
    for (const value of [
      {},
      { page: 2, pageSize: 50 },
      { page: Number.MAX_SAFE_INTEGER, pageSize: 1 },
    ])
      expect(getEvaluationAdjudicationHistoryQueryIssues(value)).toEqual([]);
    for (const value of [
      { page: 0 },
      { page: "1" },
      { page: 1.5 },
      { pageSize: 0 },
      { pageSize: 51 },
      { page: Number.MAX_SAFE_INTEGER, pageSize: 2 },
      { resultId: "not-a-query-filter" },
    ])
      expect(getEvaluationAdjudicationHistoryQueryIssues(value).length).toBeGreaterThan(0);
  });

  it("rejects omitted events, noncontiguous or reordered versions, and malformed previous-event chains", () => {
    const mutations: ((value: EvaluationAdjudicationHistoryV1) => void)[] = [
      (value) => {
        value.items.pop();
      },
      (value) => {
        value.total += 1;
      },
      (value) => {
        value.items.reverse();
      },
      (value) => {
        required(value.items[0]).version = 4;
      },
      (value) => {
        required(value.items[0]).previousEventId = null;
      },
      (value) => {
        required(value.items[0]).previousEventId = "wrong-event";
      },
      (value) => {
        required(value.items[1]).previousEventId = required(
          value.items[0],
        ).adjudication.adjudicationId;
      },
      (value) => {
        required(value.items[1]).adjudication.adjudicationId = required(
          value.items[0],
        ).adjudication.adjudicationId;
      },
    ];
    for (const mutate of mutations) {
      const value = history();
      mutate(value);
      expect(Value.Check(EvaluationAdjudicationHistoryV1Schema, value)).toBe(true);
      expect(getEvaluationAdjudicationHistoryIssues(value).length).toBeGreaterThan(0);
    }
    const earliest = history(2);
    required(earliest.items[0]).previousEventId = "invented-predecessor";
    expect(getEvaluationAdjudicationHistoryIssues(earliest).length).toBeGreaterThan(0);
    const single = history(1, 1);
    required(single.items[0]).previousEventId = required(
      single.items[0],
    ).adjudication.adjudicationId;
    expect(getEvaluationAdjudicationHistoryIssues(single).length).toBeGreaterThan(0);
    expect(
      getEvaluationAdjudicationHistoryIssues({
        ...history(),
        page: Number.MAX_SAFE_INTEGER,
        pageSize: 50,
      }).length,
    ).toBeGreaterThan(0);
  });

  it.each(["resultId", "resultDigest", "occurrenceKey", "caseId", "arm"] as const)(
    "rejects a history event from another %s",
    (field) => {
      const value = history();
      const replacements = {
        resultId: "other-result",
        resultDigest: "b".repeat(64),
        occurrenceKey: key(10),
        caseId: "other-case",
        arm: "candidate",
      };
      Object.assign(required(value.items[1]).adjudication, { [field]: replacements[field] });
      expect(Value.Check(EvaluationAdjudicationHistoryV1Schema, value)).toBe(true);
      expect(getEvaluationAdjudicationHistoryIssues(value).length).toBeGreaterThan(0);
    },
  );
});

describe("strict adjudication JSON, identities, and encoded budgets", () => {
  it("rejects transformed nested scope, audit, actor, and expectation identities", () => {
    const fixtures: [() => object, (value: unknown) => string[], string[]][] = [
      [
        scope,
        getEvaluationAdjudicationScopeIssues,
        ["repositoryId", "evaluationId", "cellId", "resultId"],
      ],
      [
        request,
        getEvaluationAdjudicationChangeRequestIssues,
        ["changeId", "judgment.expectedFindingId"],
      ],
      [
        context,
        getEvaluationAdjudicationContextIssues,
        [
          "scope.resultId",
          "caseId",
          "expectations.expected.0.expectedFindingId",
          "items.0.adjudication.adjudicationId",
          "items.0.adjudication.actor.issuer",
          "items.0.adjudication.actor.subject",
        ],
      ],
      [
        change,
        getEvaluationAdjudicationChangeIssues,
        ["scope.cellId", "adjudication.adjudicationId", "adjudication.actor.subject"],
      ],
      [
        history,
        getEvaluationAdjudicationHistoryIssues,
        ["scope.repositoryId", "items.0.previousEventId", "items.0.adjudication.actor.issuer"],
      ],
    ];
    for (const [make, validate, paths] of fixtures)
      for (const path of paths)
        for (const suffix of ["\n", " ", "\u007f"]) {
          const value = make();
          appendAtPath(value, path, suffix);
          expect(validate(value).length, path).toBeGreaterThan(0);
        }
  });

  it("rejects non-JSON data without invoking accessors or retaining discarded array properties", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const accessor = Object.defineProperty(request(), "changeId", {
      enumerable: true,
      get() {
        throw new Error("The getter must not execute.");
      },
    });
    for (const value of [
      null,
      undefined,
      [],
      { ...request(), changeId: "bad\ud800" },
      { ...request(), extra: 1n },
      { ...request(), expectedVersion: Number.NaN },
      { ...request(), extra: new Date(now) },
      { ...request(), [Symbol("hidden")]: true },
      Object.defineProperty(request(), "hidden", { value: true }),
      circular,
      accessor,
    ]) {
      expect(() => getEvaluationAdjudicationChangeRequestIssues(value)).not.toThrow();
      expect(getEvaluationAdjudicationChangeRequestIssues(value).length).toBeGreaterThan(0);
    }
    expect(
      getEvaluationAdjudicationChangeRequestIssues(Object.assign(Object.create(null), request())),
    ).toEqual([]);
    for (const items of [new Array(2), Object.assign(context().items, { hidden: true })])
      expect(
        getEvaluationAdjudicationContextIssues({ ...context(), items }).length,
      ).toBeGreaterThan(0);
  });

  it("enforces the 2 MiB context limit using real multibyte human audit text", () => {
    const value = contextAtByteLimit();
    expect(bytes(value)).toBe(maximumEvaluationAdjudicationReadUtf8Bytes);
    expect(getEvaluationAdjudicationContextIssues(value)).toEqual([]);
    const entry = required(
      required(value.items.find((item) => required(item.adjudication).reason.length < 2048))
        .adjudication,
    );
    entry.reason += "雪";
    expect(bytes(value)).toBe(maximumEvaluationAdjudicationReadUtf8Bytes + 3);
    expect(Value.Check(EvaluationAdjudicationContextV1Schema, value)).toBe(true);
    expect(getEvaluationAdjudicationContextIssues(value).join(" ")).toMatch(
      /aggregate UTF-8 byte limit/u,
    );
  });

  it("enforces the smaller 256 KiB accepted-change response budget", () => {
    const value = change();
    const remaining = maximumEvaluationAdjudicationChangeUtf8Bytes - bytes(value);
    value.adjudication.createdAt = `2026-09-08T01:00:00.${"0".repeat(remaining + 3)}Z`;
    expect(bytes(value)).toBe(maximumEvaluationAdjudicationChangeUtf8Bytes);
    expect(getEvaluationAdjudicationChangeIssues(value)).toEqual([]);
    value.adjudication.reason += "雪";
    expect(Value.Check(EvaluationAdjudicationChangeV1Schema, value)).toBe(true);
    expect(getEvaluationAdjudicationChangeIssues(value).join(" ")).toMatch(
      /aggregate UTF-8 byte limit/u,
    );
  });
});
