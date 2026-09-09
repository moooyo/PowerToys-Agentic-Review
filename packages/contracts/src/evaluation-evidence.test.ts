import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterAll, describe, expect, it } from "vitest";
import {
  type EvaluationEvidenceBinding,
  EvaluationEvidenceBindingSchema,
  type EvaluationResultEvidenceAssetQuery,
  type EvaluationResultEvidenceAssetV1,
  EvaluationResultEvidenceAssetV1Schema,
  type EvaluationResultEvidenceListV1,
  EvaluationResultEvidenceListV1Schema,
  getEvaluationResultEvidenceAssetIssues,
  getEvaluationResultEvidenceAssetQueryIssues,
  getEvaluationResultEvidenceListIssues,
  maximumEvaluationResultEvidenceAssetCount,
  maximumEvaluationResultEvidenceCheckCount,
  maximumEvaluationResultEvidenceUtf8Bytes,
} from "./evaluation-evidence.js";
import type { EvidenceAssetManifest } from "./evidence-assets.js";

const now = "2026-09-08T01:00:00.000Z";
const originalDateTime = FormatRegistry.Get("date-time");
afterAll(() => {
  if (originalDateTime === undefined) FormatRegistry.Delete("date-time");
  else FormatRegistry.Set("date-time", originalDateTime);
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("The fixture entry is missing.");
  return value;
}

function binding(): EvaluationEvidenceBinding {
  return {
    repositoryId: "repository-1",
    evaluationId: "evaluation-1",
    cellId: "cell-baseline",
    resultId: "result-1",
    resultDigest: "a".repeat(64),
    runId: "run-baseline",
    requestId: "request-baseline",
    jobId: "job-baseline",
    runAttemptId: "attempt-1",
    profileVersionId: "profile:baseline:v1",
    revisionKey: "b".repeat(64),
    planDigest: "c".repeat(64),
  };
}

function manifest(): EvidenceAssetManifest {
  const selected = binding();
  return {
    id: "asset-1",
    repositoryId: selected.repositoryId,
    runId: selected.runId,
    requestId: selected.requestId,
    jobId: selected.jobId,
    runAttemptId: selected.runAttemptId,
    profileVersionId: selected.profileVersionId,
    revisionKey: selected.revisionKey,
    planDigest: selected.planDigest,
    metadata: {
      kind: "screenshot",
      mediaType: "image/png",
      sizeBytes: 1024,
      sha256: "d".repeat(64),
      capturedAt: now,
      checkId: `${selected.profileVersionId}:open-dialog`,
    },
    state: "finalized",
    createdAt: now,
    finalizedAt: now,
    retiredAt: null,
  };
}

function asset(): EvaluationResultEvidenceAssetV1 {
  return {
    schemaVersion: "EvaluationResultEvidenceAssetV1",
    binding: binding(),
    assetId: "asset-1",
    checkIds: [`${binding().profileVersionId}:open-dialog`],
    manifest: manifest(),
  };
}

function list(): EvaluationResultEvidenceListV1 {
  const { assetId, checkIds, manifest } = asset();
  return {
    schemaVersion: "EvaluationResultEvidenceListV1",
    binding: binding(),
    items: [
      { assetId, checkIds, manifest },
      {
        assetId: "missing-asset",
        checkIds: [`${binding().profileVersionId}:build`],
        manifest: null,
      },
    ],
  };
}

function query(): EvaluationResultEvidenceAssetQuery {
  return {
    repositoryId: "repository-1",
    evaluationId: "evaluation-1",
    cellId: "cell-baseline",
    resultId: "result-1",
    assetId: "asset-1",
  };
}

function atByteLimit(): EvaluationResultEvidenceListV1 {
  const value: EvaluationResultEvidenceListV1 = {
    schemaVersion: "EvaluationResultEvidenceListV1",
    binding: binding(),
    items: Array.from({ length: maximumEvaluationResultEvidenceAssetCount }, (_, index) => ({
      assetId: `asset-${index}`,
      checkIds: Array.from(
        { length: maximumEvaluationResultEvidenceCheckCount },
        (_, check) => `${binding().profileVersionId}:check-${String(check).padStart(3, "0")}`,
      ),
      manifest: null,
    })),
  };
  let remaining =
    maximumEvaluationResultEvidenceUtf8Bytes -
    new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const prefixLength = value.binding.profileVersionId.length + 1;
  for (const item of value.items) {
    item.checkIds = item.checkIds.map((checkId) => {
      const added = Math.min(128 - (checkId.length - prefixLength), remaining);
      remaining -= added;
      return `${checkId}${"x".repeat(added)}`;
    });
  }
  if (remaining !== 0)
    throw new Error("The fixture could not fill the structural DTO byte budget.");
  return value;
}

describe("evaluation evidence selection contracts", () => {
  it("binds the exact evaluation result and immutable execution identities without review authority", () => {
    const value = binding();
    expect(Value.Check(EvaluationEvidenceBindingSchema, value)).toBe(true);
    expect(Object.keys(value).sort()).toEqual(
      [
        "repositoryId",
        "evaluationId",
        "cellId",
        "resultId",
        "resultDigest",
        "runId",
        "requestId",
        "jobId",
        "runAttemptId",
        "profileVersionId",
        "revisionKey",
        "planDigest",
      ].sort(),
    );
    for (const extra of [
      { reviewRunId: "run-baseline" },
      { authoritative: true },
      { sourceId: "source-1" },
      { executionDigest: "e".repeat(64) },
    ])
      expect(Value.Check(EvaluationEvidenceBindingSchema, { ...value, ...extra })).toBe(false);
  });

  it("requires all five exact asset query identities", () => {
    const value = query();
    const original = structuredClone(value);
    expect(getEvaluationResultEvidenceAssetQueryIssues(value)).toEqual([]);
    expect(value).toEqual(original);
    for (const field of Object.keys(value)) {
      const missing: Record<string, unknown> = { ...value };
      delete missing[field];
      expect(getEvaluationResultEvidenceAssetQueryIssues(missing).length, field).toBeGreaterThan(0);
      for (const invalid of [
        "",
        "a".repeat(129),
        " id",
        "id ",
        "id\n",
        "id\u007f",
        "../id",
        "id/other",
        1,
        null,
        ["id"],
      ])
        expect(
          getEvaluationResultEvidenceAssetQueryIssues({ ...value, [field]: invalid }).length,
          field,
        ).toBeGreaterThan(0);
    }
  });

  it("rejects query authority, path, availability and direct chunk controls", () => {
    for (const extra of [
      { actor: { issuer: "issuer", subject: "subject" } },
      { runId: "run-1" },
      { available: true },
      { path: "/private/file" },
      { offset: 0 },
      { maximumBytes: 1024 },
    ])
      expect(
        getEvaluationResultEvidenceAssetQueryIssues({ ...query(), ...extra }).length,
      ).toBeGreaterThan(0);
  });
});

describe("evaluation evidence list and asset projection", () => {
  it("preserves present and missing manifests without inventing availability", () => {
    const value = list();
    const original = structuredClone(value);
    expect(getEvaluationResultEvidenceListIssues(value)).toEqual([]);
    expect(getEvaluationResultEvidenceAssetIssues(asset())).toEqual([]);
    expect(getEvaluationResultEvidenceListIssues({ ...value, items: [] })).toEqual([]);
    expect(value).toEqual(original);
    expect(
      getEvaluationResultEvidenceAssetIssues({ ...asset(), manifest: null }).length,
    ).toBeGreaterThan(0);
    expect(
      getEvaluationResultEvidenceListIssues({
        ...value,
        items: [{ ...value.items[0], available: true }],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      getEvaluationResultEvidenceAssetIssues({ ...asset(), available: true }).length,
    ).toBeGreaterThan(0);
  });

  it("bounds the result to 256 distinct referenced assets and 160 explicit check references", () => {
    const value = list();
    value.items = Array.from({ length: maximumEvaluationResultEvidenceAssetCount }, (_, index) => ({
      assetId: `missing-${index}`,
      checkIds: [`${value.binding.profileVersionId}:build`],
      manifest: null,
    }));
    expect(maximumEvaluationResultEvidenceAssetCount).toBe(256);
    expect(maximumEvaluationResultEvidenceCheckCount).toBe(160);
    expect(getEvaluationResultEvidenceListIssues(value)).toEqual([]);
    value.items.push({ ...required(value.items[0]), assetId: "excess-asset" });
    expect(getEvaluationResultEvidenceListIssues(value).length).toBeGreaterThan(0);
    const reference = {
      assetId: "missing-asset",
      manifest: null,
      checkIds: Array.from(
        { length: 160 },
        (_, index) => `${value.binding.profileVersionId}:check-${index}`,
      ),
    };
    expect(getEvaluationResultEvidenceListIssues({ ...list(), items: [reference] })).toEqual([]);
    reference.checkIds.push(`${value.binding.profileVersionId}:excess-check`);
    expect(
      getEvaluationResultEvidenceListIssues({ ...list(), items: [reference] }).length,
    ).toBeGreaterThan(0);
  });

  it("rejects duplicate asset identities even when one manifest is missing", () => {
    const value = list();
    required(value.items[1]).assetId = required(value.items[0]).assetId;
    expect(Value.Check(EvaluationResultEvidenceListV1Schema, value)).toBe(true);
    expect(getEvaluationResultEvidenceListIssues(value).join(" ")).toMatch(/must be unique/u);
  });

  it("requires nonempty unique check references within the exact selected profile namespace", () => {
    for (const checkIds of [
      [],
      [`${binding().profileVersionId}:open-dialog`, `${binding().profileVersionId}:open-dialog`],
      ["other-profile:open-dialog"],
      ["profile:baseline:v10:open-dialog"],
      ["Profile:baseline:v1:open-dialog"],
      [`${binding().profileVersionId}:`],
      [`${binding().profileVersionId}:${"x".repeat(257)}`],
    ]) {
      const value = { ...list(), items: [{ assetId: "missing-asset", checkIds, manifest: null }] };
      expect(getEvaluationResultEvidenceListIssues(value).length).toBeGreaterThan(0);
    }
    const checkIds = [
      `${binding().profileVersionId}:check:part`,
      `${binding().profileVersionId}:Check:part`,
    ];
    expect(
      getEvaluationResultEvidenceListIssues({
        ...list(),
        items: [{ assetId: "missing-asset", checkIds, manifest: null }],
      }),
    ).toEqual([]);
    expect(
      getEvaluationResultEvidenceListIssues({
        ...list(),
        items: [
          {
            assetId: "missing-asset",
            checkIds: [`${binding().profileVersionId}:${"x".repeat(129)}`],
            manifest: null,
          },
        ],
      }),
    ).toEqual([]);
  });

  it.each([
    "repositoryId",
    "runId",
    "requestId",
    "jobId",
    "runAttemptId",
    "profileVersionId",
    "revisionKey",
    "planDigest",
  ] as const)("rejects a manifest belonging to another binding %s", (field) => {
    const value = asset();
    value.manifest[field] =
      field === "revisionKey" || field === "planDigest" ? "f".repeat(64) : "other-identity";
    expect(Value.Check(EvaluationResultEvidenceAssetV1Schema, value)).toBe(true);
    expect(getEvaluationResultEvidenceAssetIssues(value).length).toBeGreaterThan(0);
    expect(
      getEvaluationResultEvidenceListIssues({
        ...list(),
        items: [{ assetId: value.assetId, checkIds: value.checkIds, manifest: value.manifest }],
      }).length,
    ).toBeGreaterThan(0);
  });

  it("requires the manifest asset identity and every check association to agree", () => {
    const mutations: ((value: EvaluationResultEvidenceAssetV1) => void)[] = [
      (value) => {
        value.manifest.id = "other-asset";
      },
      (value) => {
        value.manifest.metadata.checkId = `${value.binding.profileVersionId}:other-check`;
      },
      (value) => {
        Reflect.deleteProperty(value.manifest.metadata, "checkId");
      },
      (value) => {
        value.checkIds.push(`${value.binding.profileVersionId}:another-check`);
      },
    ];
    for (const mutate of mutations) {
      const value = asset();
      mutate(value);
      expect(Value.Check(EvaluationResultEvidenceAssetV1Schema, value)).toBe(true);
      expect(getEvaluationResultEvidenceAssetIssues(value).length).toBeGreaterThan(0);
      expect(
        getEvaluationResultEvidenceListIssues({
          ...list(),
          items: [{ assetId: value.assetId, checkIds: value.checkIds, manifest: value.manifest }],
        }).length,
      ).toBeGreaterThan(0);
    }
  });

  it("requires retirement timestamps to agree with state without claiming content verification", () => {
    const finalized = asset();
    const retired = asset();
    retired.manifest.state = "retired";
    retired.manifest.retiredAt = now;
    expect(getEvaluationResultEvidenceAssetIssues(finalized)).toEqual([]);
    expect(getEvaluationResultEvidenceAssetIssues(retired)).toEqual([]);
    finalized.manifest.retiredAt = now;
    retired.manifest.retiredAt = null;
    expect(getEvaluationResultEvidenceAssetIssues(finalized).length).toBeGreaterThan(0);
    expect(getEvaluationResultEvidenceAssetIssues(retired).length).toBeGreaterThan(0);
    const unverified = asset();
    unverified.manifest.metadata.sha256 = "f".repeat(64);
    expect(getEvaluationResultEvidenceAssetIssues(unverified)).toEqual([]);
    expect(unverified).not.toHaveProperty("available");
    expect(unverified.manifest).not.toHaveProperty("verified");
  });
});

describe("strict evaluation evidence JSON and byte limits", () => {
  it("rejects malformed scope identities throughout the binding and asset references", () => {
    for (const [field, entry] of Object.entries(binding())) {
      if (!field.endsWith("Id")) continue;
      for (const invalid of [` ${entry}`, `${entry}\n`, `${entry}\u007f`, null]) {
        const changed = { ...binding(), [field]: invalid };
        expect(
          getEvaluationResultEvidenceAssetIssues({ ...asset(), binding: changed }).length,
        ).toBeGreaterThan(0);
        expect(
          getEvaluationResultEvidenceListIssues({ ...list(), binding: changed }).length,
        ).toBeGreaterThan(0);
      }
    }
    for (const assetId of ["asset-1\n", " asset-1", "asset-1/other", null]) {
      expect(
        getEvaluationResultEvidenceAssetIssues({ ...asset(), assetId }).length,
      ).toBeGreaterThan(0);
      expect(
        getEvaluationResultEvidenceListIssues({
          ...list(),
          items: [{ ...list().items[0], assetId }],
        }).length,
      ).toBeGreaterThan(0);
    }
  });

  it("rejects non-JSON values, hidden properties, sparse arrays, and throwing accessors", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const accessor = Object.defineProperty(query(), "assetId", {
      enumerable: true,
      get() {
        throw new Error("The getter must not execute.");
      },
    });
    const inaccessible = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("The proxy cannot be inspected.");
        },
      },
    );
    for (const value of [
      null,
      undefined,
      [],
      { ...query(), assetId: "bad\ud800" },
      { ...query(), extra: 1n },
      { ...query(), extra: Number.POSITIVE_INFINITY },
      { ...query(), extra: new Date(now) },
      { ...query(), [Symbol("hidden")]: true },
      Object.defineProperty(query(), "hidden", { value: true }),
      circular,
      accessor,
      inaccessible,
    ]) {
      expect(() => getEvaluationResultEvidenceAssetQueryIssues(value)).not.toThrow();
      expect(getEvaluationResultEvidenceAssetQueryIssues(value).length).toBeGreaterThan(0);
    }
    for (const items of [new Array(1), Object.assign(list().items, { hidden: true })])
      expect(getEvaluationResultEvidenceListIssues({ ...list(), items }).length).toBeGreaterThan(0);
    expect(
      getEvaluationResultEvidenceAssetQueryIssues(Object.assign(Object.create(null), query())),
    ).toEqual([]);
    const invalidCheckIds = Object.assign(asset().checkIds, { ignored: true });
    expect(
      getEvaluationResultEvidenceAssetIssues({ ...asset(), checkIds: invalidCheckIds }).length,
    ).toBeGreaterThan(0);
  });

  it("rejects private storage paths, content payloads, and fabricated verification flags", () => {
    for (const extra of [
      { available: true },
      { verified: true },
      { storagePath: "/private/evidence.png" },
      { base64: "AQID" },
    ]) {
      expect(
        getEvaluationResultEvidenceAssetIssues({ ...asset(), ...extra }).length,
      ).toBeGreaterThan(0);
      expect(
        getEvaluationResultEvidenceAssetIssues({
          ...asset(),
          manifest: { ...manifest(), ...extra },
        }).length,
      ).toBeGreaterThan(0);
    }
  });

  it("enforces the aggregate 2 MiB budget independently of owner-side report membership checks", () => {
    const value = atByteLimit();
    const bytes = (entry: unknown) => new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    expect(bytes(value)).toBe(maximumEvaluationResultEvidenceUtf8Bytes);
    expect(getEvaluationResultEvidenceListIssues(value)).toEqual([]);
    const prefixLength = value.binding.profileVersionId.length + 1;
    const item = required(
      value.items.find((entry) =>
        entry.checkIds.some((checkId) => checkId.length - prefixLength < 128),
      ),
    );
    const index = item.checkIds.findIndex((checkId) => checkId.length - prefixLength < 128);
    item.checkIds[index] = `${required(item.checkIds[index])}x`;
    expect(bytes(value)).toBe(maximumEvaluationResultEvidenceUtf8Bytes + 1);
    expect(Value.Check(EvaluationResultEvidenceListV1Schema, value)).toBe(true);
    expect(getEvaluationResultEvidenceListIssues(value).join(" ")).toMatch(
      /aggregate UTF-8 byte limit/u,
    );
  });
});
