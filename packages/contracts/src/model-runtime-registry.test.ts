import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  getModelRuntimeAuditEventIssues,
  getModelRuntimeControlIssues,
  getModelRuntimeControlRequestIssues,
  getModelRuntimeHistoryIssues,
  getModelRuntimeHistoryQueryIssues,
  getModelRuntimeListIssues,
  getModelRuntimeListQueryIssues,
  getModelRuntimeOptionsIssues,
  getModelRuntimeOptionsQueryIssues,
  getModelRuntimeRegisterRequestIssues,
  getModelRuntimeRegistrationIssues,
  getModelRuntimeStatusIssues,
  type ModelRuntimeAuditEventV1,
  type ModelRuntimeHistoryV1,
  type ModelRuntimeListV1,
  type ModelRuntimeOptionsV1,
  type ModelRuntimeRegisterRequest,
  type ModelRuntimeRegistrationV1,
  ModelRuntimeRegistrationV1Schema,
  type ModelRuntimeStatusV1,
  maximumModelRuntimeRegistryPageSize,
  maximumModelRuntimeRegistryReadUtf8Bytes,
  maximumModelRuntimeRegistryRequestUtf8Bytes,
} from "./model-runtime-registry.js";

const now = "2026-09-08T01:00:00.000Z";
const actor = { issuer: "https://identity.example", subject: "platform-operator" };
function registration(): ModelRuntimeRegistrationV1 {
  return {
    schemaVersion: "ModelRuntimeRegistrationV1",
    id: "registration-1",
    name: "Frozen expected runtime",
    requestedModel: "requested-model",
    identity: {
      schemaVersion: "ModelRuntimeIdentityV1",
      providerId: "provider-1",
      endpointSha256: "a".repeat(64),
      modelId: "observed-model",
      client: {
        kind: "codex_cli",
        version: "fixture-version",
        executableSha256: "b".repeat(64),
        launchPolicySha256: "c".repeat(64),
      },
      relay: { implementationSha256: "d".repeat(64), policySha256: "e".repeat(64) },
    },
    identitySha256: "f".repeat(64),
    createdAt: now,
    createdBy: { ...actor },
  };
}
function request(): ModelRuntimeRegisterRequest {
  const { name, requestedModel, identity } = registration();
  return { changeId: "register-change", name, requestedModel, identity, enabled: true };
}
function status(): ModelRuntimeStatusV1 {
  return {
    schemaVersion: "ModelRuntimeStatusV1",
    registration: registration(),
    control: {
      schemaVersion: "ModelRuntimeControlV1",
      registrationId: "registration-1",
      version: 1,
      enabled: true,
      updatedAt: now,
      updatedBy: { ...actor },
    },
  };
}
function audit(version: number): ModelRuntimeAuditEventV1 {
  return {
    schemaVersion: "ModelRuntimeAuditEventV1",
    id: `audit-${version}`,
    registrationId: "registration-1",
    changeId: `change-${version}`,
    operation: version === 1 ? "register" : "control",
    previousVersion: version - 1,
    version,
    enabled: version % 2 === 1,
    reason: version === 1 ? null : "Update runtime availability.",
    createdAt: now,
    createdBy: { ...actor },
  };
}
function history(): ModelRuntimeHistoryV1 {
  return {
    schemaVersion: "ModelRuntimeHistoryV1",
    registrationId: "registration-1",
    page: 1,
    pageSize: 20,
    total: 3,
    items: [audit(3), audit(2), audit(1)],
  };
}
function list(): ModelRuntimeListV1 {
  return {
    schemaVersion: "ModelRuntimeListV1",
    page: 1,
    pageSize: 20,
    total: 1,
    items: [status()],
  };
}
function options(): ModelRuntimeOptionsV1 {
  return {
    schemaVersion: "ModelRuntimeOptionsV1",
    repositoryId: "repository-1",
    page: 1,
    pageSize: 20,
    total: 1,
    items: [registration()],
  };
}

describe("expected model runtime registration", () => {
  it("retains expected identity separately from requested names without authenticating claimed hashes", () => {
    const value = registration();
    const original = structuredClone(value);
    expect(getModelRuntimeRegistrationIssues(value)).toEqual([]);
    expect(Value.Check(ModelRuntimeRegistrationV1Schema, value)).toBe(true);
    expect(getModelRuntimeRegisterRequestIssues(request())).toEqual([]);
    expect(getModelRuntimeStatusIssues(status())).toEqual([]);
    expect(value.requestedModel).not.toBe(value.identity.modelId);
    expect(value).toEqual(original);
  });

  it("rejects client supplied storage identity, actor, digests, authority, credentials and replay controls", () => {
    for (const extra of [
      { id: "selected" },
      { identitySha256: "a".repeat(64) },
      { registrationSha256: "b".repeat(64) },
      { createdBy: actor },
      { createdAt: now },
      { verified: true },
      { token: "private" },
      { headers: {} },
      { replayOnly: true },
    ])
      expect(
        getModelRuntimeRegisterRequestIssues({ ...request(), ...extra }).length,
      ).toBeGreaterThan(0);
    for (const extra of [
      { enabled: true },
      { endpoint: "https://fixture.invalid" },
      { verified: true },
    ])
      expect(
        getModelRuntimeRegistrationIssues({ ...registration(), ...extra }).length,
      ).toBeGreaterThan(0);
  });

  it("requires exact IDs, actor identities and bounded model/name text", () => {
    for (const invalid of ["", " leading", "trailing ", "id\n", "a\u202eb", "\ud800"])
      for (const value of [
        { ...registration(), id: invalid },
        { ...registration(), name: invalid },
        { ...registration(), requestedModel: invalid },
        { ...registration(), createdBy: { ...actor, subject: invalid } },
      ])
        expect(getModelRuntimeRegistrationIssues(value).length).toBeGreaterThan(0);
    expect(
      getModelRuntimeRegisterRequestIssues({ ...request(), changeId: "id\n" }).length,
    ).toBeGreaterThan(0);
    expect(
      getModelRuntimeRegistrationIssues({ ...registration(), name: "n".repeat(129) }).length,
    ).toBeGreaterThan(0);
    expect(
      getModelRuntimeRegistrationIssues({ ...registration(), requestedModel: "m".repeat(1025) })
        .length,
    ).toBeGreaterThan(0);
  });

  it("requires both immutable client executable and effective launch-policy identities", () => {
    for (const key of ["executableSha256", "launchPolicySha256"] as const) {
      const value = registration();
      const client: Record<string, unknown> = { ...value.identity.client };
      delete client[key];
      expect(
        getModelRuntimeRegistrationIssues({ ...value, identity: { ...value.identity, client } })
          .length,
      ).toBeGreaterThan(0);
    }
  });

  it("validates real calendar dates without registering global format callbacks", () => {
    const previous = FormatRegistry.Get("date-time");
    expect(getModelRuntimeRegistrationIssues(registration())).toEqual([]);
    expect(FormatRegistry.Get("date-time")).toBe(previous);
    for (const createdAt of [
      "2026-02-31T00:00:00Z",
      "1900-02-29T00:00:00Z",
      "2026-09-08T24:00:00Z",
      "2026-09-08T00:00:00.0001Z",
    ])
      expect(
        getModelRuntimeRegistrationIssues({ ...registration(), createdAt }).length,
      ).toBeGreaterThan(0);
    expect(
      getModelRuntimeRegistrationIssues({
        ...registration(),
        createdAt: "2000-02-29T00:00:00.12+05:30",
      }),
    ).toEqual([]);
  });

  it("keeps control separate and requires the initial actor, time and registration identity", () => {
    const value = status();
    for (const changed of [
      { registrationId: "other" },
      { updatedAt: "2026-09-08T00:00:00Z" },
      { updatedAt: "2026-09-08T02:00:00Z" },
      { updatedBy: { ...actor, subject: "other" } },
    ])
      expect(
        getModelRuntimeStatusIssues({ ...value, control: { ...value.control, ...changed } }).length,
      ).toBeGreaterThan(0);
    expect(
      getModelRuntimeStatusIssues({
        ...value,
        control: {
          ...value.control,
          version: 2,
          enabled: false,
          updatedAt: "2026-09-08T02:00:00Z",
        },
      }),
    ).toEqual([]);
    expect(
      getModelRuntimeControlIssues({ ...value.control, version: Number.MAX_SAFE_INTEGER }),
    ).toEqual([]);
    expect(getModelRuntimeControlIssues({ ...value.control, version: 0 }).length).toBeGreaterThan(
      0,
    );
  });

  it("requires an incrementable CAS version and an explicit bounded control reason", () => {
    const value = {
      changeId: "control-change",
      expectedVersion: 1,
      enabled: false,
      reason: "Disable the expected runtime.\nRetain its history.",
    };
    expect(getModelRuntimeControlRequestIssues(value)).toEqual([]);
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, "1"])
      expect(
        getModelRuntimeControlRequestIssues({ ...value, expectedVersion: invalid }).length,
      ).toBeGreaterThan(0);
    for (const reason of ["", "  ", "reason\0", "a\u202eb", "x".repeat(2049)])
      expect(getModelRuntimeControlRequestIssues({ ...value, reason }).length).toBeGreaterThan(0);
    for (const extra of [{ identity: registration().identity }, { actor }, { replayOnly: true }])
      expect(getModelRuntimeControlRequestIssues({ ...value, ...extra }).length).toBeGreaterThan(0);
  });

  it("rejects non-JSON values without invoking metadata getters", () => {
    let accessed = false;
    const value = registration();
    Object.defineProperty(value, "identity", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("Getter must not run.");
      },
    });
    expect(getModelRuntimeRegistrationIssues(value).length).toBeGreaterThan(0);
    expect(accessed).toBe(false);
    const cyclic: Record<string, unknown> = { ...request() };
    cyclic.self = cyclic;
    expect(getModelRuntimeRegisterRequestIssues(cyclic).length).toBeGreaterThan(0);
    expect(maximumModelRuntimeRegistryRequestUtf8Bytes).toBe(32 * 1024);
    expect(maximumModelRuntimeRegistryReadUtf8Bytes).toBe(2 * 1024 * 1024);
    expect(
      getModelRuntimeRegisterRequestIssues({
        ...request(),
        name: "界".repeat(maximumModelRuntimeRegistryRequestUtf8Bytes),
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe("model runtime lists and immutable history", () => {
  it("separates platform lists from repository options without exposing management controls", () => {
    expect(getModelRuntimeListIssues(list())).toEqual([]);
    expect(getModelRuntimeOptionsIssues(options())).toEqual([]);
    expect(
      getModelRuntimeOptionsIssues({ ...options(), items: [status()] }).length,
    ).toBeGreaterThan(0);
    expect(
      getModelRuntimeOptionsIssues({ ...options(), repositoryId: "repository\n" }).length,
    ).toBeGreaterThan(0);
    expect(getModelRuntimeOptionsIssues({ ...options(), enabled: true }).length).toBeGreaterThan(0);
    expect(getModelRuntimeOptionsQueryIssues({ enabled: true }).length).toBeGreaterThan(0);
    expect(getModelRuntimeListQueryIssues({ enabled: false })).toEqual([]);
  });

  it("defaults optional pages and rejects unsafe offsets, unsupported filters and oversized pages", () => {
    for (const helper of [
      getModelRuntimeListQueryIssues,
      getModelRuntimeHistoryQueryIssues,
      getModelRuntimeOptionsQueryIssues,
    ]) {
      expect(helper({})).toEqual([]);
      expect(helper({ page: 1, pageSize: maximumModelRuntimeRegistryPageSize })).toEqual([]);
      for (const value of [
        { page: 0 },
        { pageSize: 51 },
        { page: "1" },
        { page: Number.MAX_SAFE_INTEGER, pageSize: 50 },
        { actor },
      ])
        expect(helper(value).length).toBeGreaterThan(0);
    }
    expect(getModelRuntimeHistoryQueryIssues({ enabled: true }).length).toBeGreaterThan(0);
  });

  it("requires complete pages and unique registration identities", () => {
    expect(getModelRuntimeListIssues({ ...list(), page: 2, items: [] })).toEqual([]);
    for (const value of [
      { ...list(), items: [] },
      { ...list(), total: 2 },
      { ...list(), total: 2, items: [status(), status()] },
    ])
      expect(getModelRuntimeListIssues(value).length).toBeGreaterThan(0);
    expect(
      getModelRuntimeOptionsIssues({
        ...options(),
        total: 2,
        items: [registration(), registration()],
      }).length,
    ).toBeGreaterThan(0);
  });

  it("retains consecutive audit versions with operation-specific reason semantics", () => {
    expect(getModelRuntimeAuditEventIssues(audit(1))).toEqual([]);
    expect(getModelRuntimeAuditEventIssues(audit(2))).toEqual([]);
    for (const value of [
      { ...audit(1), reason: "not an initial null reason" },
      { ...audit(1), previousVersion: 1 },
      { ...audit(2), reason: null },
      { ...audit(2), version: 4 },
      { ...audit(2), operation: "register" },
    ])
      expect(getModelRuntimeAuditEventIssues(value).length).toBeGreaterThan(0);
  });

  it("requires one history scope with complete latest-first versions and distinct changes", () => {
    expect(getModelRuntimeHistoryIssues(history())).toEqual([]);
    expect(
      getModelRuntimeHistoryIssues({ ...history(), pageSize: 2, items: [audit(3), audit(2)] }),
    ).toEqual([]);
    expect(
      getModelRuntimeHistoryIssues({ ...history(), page: 2, pageSize: 2, items: [audit(1)] }),
    ).toEqual([]);
    for (const items of [
      [audit(1), audit(2), audit(3)],
      [audit(3), audit(1)],
      [audit(3), { ...audit(2), registrationId: "other" }, audit(1)],
      [audit(3), { ...audit(2), id: "audit-3" }, audit(1)],
      [audit(3), { ...audit(2), changeId: "change-3" }, audit(1)],
      [audit(3), { ...audit(2), createdAt: "2026-09-08T02:00:00Z" }, audit(1)],
    ])
      expect(getModelRuntimeHistoryIssues({ ...history(), items }).length).toBeGreaterThan(0);
  });
});
