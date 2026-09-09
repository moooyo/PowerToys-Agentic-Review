import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  createEvaluationManagementFixture,
  evaluationActor as maintainer,
  evaluationAdministrator as administrator,
  evaluationLater as now,
  setEvaluationManagementRole,
} from "./evaluation-management.testing.js";
import {
  handleModelRuntimeRegistryRequest,
  type ModelRuntimeRegistryOperation,
  type ModelRuntimeRegistryOperationMap,
  type ModelRuntimeRegistryRequest,
  readModelRuntimeRegistrationInTransaction,
} from "./model-runtime-registry.js";

type Fixture = ReturnType<typeof createEvaluationManagementFixture>;
const fixtures: Fixture[] = [];
const later = "2026-09-08T03:00:00.000Z";
const laterStill = "2026-09-08T04:00:00.000Z";
const formats = new Map(["date-time", "uri"].map((name) => [name, FormatRegistry.Get(name)]));
beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
});
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
afterAll(() => {
  for (const [name, previous] of formats) {
    if (previous === undefined) FormatRegistry.Delete(name);
    else FormatRegistry.Set(name, previous);
  }
});
function fixture(): Fixture {
  const value = createEvaluationManagementFixture("issue");
  fixtures.push(value);
  return value;
}
function identity(): C.ModelRuntimeIdentityV1 {
  return {
    schemaVersion: "ModelRuntimeIdentityV1",
    providerId: "synthetic-provider",
    endpointSha256: sha256("https://provider.example.invalid/v1/responses"),
    modelId: "observed-synthetic-model",
    client: {
      kind: "codex_cli",
      version: "synthetic-cli",
      executableSha256: sha256("synthetic executable"),
      launchPolicySha256: sha256("synthetic launch policy"),
    },
    relay: {
      implementationSha256: sha256("synthetic relay implementation"),
      policySha256: sha256("synthetic relay policy"),
    },
  };
}
function registerRequest(
  changeId = "register-model",
  overrides: Partial<C.ModelRuntimeRegisterRequest> = {},
): C.ModelRuntimeRegisterRequest {
  return {
    changeId,
    name: "Synthetic expected runtime",
    requestedModel: "requested-synthetic-model",
    identity: identity(),
    enabled: true,
    ...overrides,
  };
}
function execute<K extends ModelRuntimeRegistryOperation>(
  f: Fixture,
  operation: K,
  input: ModelRuntimeRegistryOperationMap[K]["input"],
  timestamp = now,
  options: { readOnly?: boolean } = {},
  administrators: readonly C.OperatorPrincipal[] = [administrator],
): ModelRuntimeRegistryOperationMap[K]["output"] {
  return handleModelRuntimeRegistryRequest(
    f.database,
    { operation, input } as ModelRuntimeRegistryRequest,
    timestamp,
    administrators,
    options,
  ) as ModelRuntimeRegistryOperationMap[K]["output"];
}
function register(
  f: Fixture,
  changeId = "register-model",
  overrides: Partial<C.ModelRuntimeRegisterRequest> = {},
) {
  return execute(f, "registerModelRuntime", {
    actor: administrator,
    request: registerRequest(changeId, overrides),
  });
}
function control(
  f: Fixture,
  registrationId: string,
  expectedVersion = 1,
  enabled = false,
  changeId = "change-control",
  timestamp = later,
) {
  return execute(
    f,
    "changeModelRuntimeControl",
    {
      actor: administrator,
      registrationId,
      request: { changeId, expectedVersion, enabled, reason: "Synthetic registry control change." },
    },
    timestamp,
  );
}
function inRead<T>(database: DatabaseSync, read: () => T): T {
  database.exec("BEGIN");
  try {
    return read();
  } finally {
    database.exec("ROLLBACK");
  }
}
function state(database: DatabaseSync): string {
  return canonicalJson(
    Object.fromEntries(
      [
        ["registrations", "SELECT * FROM model_runtime_registrations ORDER BY id"],
        ["controls", "SELECT * FROM model_runtime_controls ORDER BY registration_id"],
        ["audit", "SELECT * FROM model_runtime_audit ORDER BY id"],
        ["receipts", "SELECT * FROM model_runtime_mutation_receipts ORDER BY change_id"],
      ].map(([name, sql]) => [
        name,
        database
          .prepare(sql as string)
          .all()
          .map((row) => ({ ...row })),
      ]),
    ),
  );
}
function disableTableTriggers(
  database: DatabaseSync,
  table:
    | "model_runtime_registrations"
    | "model_runtime_controls"
    | "model_runtime_audit"
    | "model_runtime_mutation_receipts",
): void {
  const triggers = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?")
    .all(table) as { name: string }[];
  for (const { name } of triggers) database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
}

describe("platform model runtime registry owner", () => {
  it("persists expected identity with two independently recomputed canonical digests and initial audit", () => {
    const f = fixture();
    const value = register(f);
    expect(C.getModelRuntimeStatusIssues(value)).toEqual([]);
    expect(value).toMatchObject({
      registration: {
        name: "Synthetic expected runtime",
        requestedModel: "requested-synthetic-model",
        identity: identity(),
        identitySha256: sha256(canonicalJson(identity())),
        createdAt: now,
        createdBy: administrator,
      },
      control: { version: 1, enabled: true, updatedAt: now, updatedBy: administrator },
    });
    const selected = inRead(f.database, () =>
      readModelRuntimeRegistrationInTransaction(f.database, value.registration.id, {
        requireEnabled: true,
        now,
      }),
    );
    expect(selected).toEqual({
      registration: value.registration,
      registrationSha256: sha256(canonicalJson(value.registration)),
      control: value.control,
    });
    expect(selected?.registrationSha256).not.toBe(value.registration.identitySha256);
    const history = execute(f, "listModelRuntimeHistory", {
      actor: administrator,
      registrationId: value.registration.id,
      query: {},
    });
    expect(history).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 20,
      items: [
        {
          operation: "register",
          previousVersion: 0,
          version: 1,
          enabled: true,
          reason: null,
          createdBy: administrator,
        },
      ],
    });
    expect(history.items[0]?.changeId).toBe("register-model");
  });

  it("creates a new immutable registration for a new intent even when its runtime identity is equal", () => {
    const f = fixture();
    const first = register(f, "register-first");
    const second = register(f, "register-second");
    expect(first.registration.id).not.toBe(second.registration.id);
    expect(first.registration.identitySha256).toBe(second.registration.identitySha256);
    expect(sha256(canonicalJson(first.registration))).not.toBe(
      sha256(canonicalJson(second.registration)),
    );
    expect(
      execute(f, "listModelRuntimeRegistrations", { actor: administrator, query: {} }).total,
    ).toBe(2);
  });

  it("accepts initially disabled registrations and exposes only enabled choices in an authorized repository", () => {
    const f = fixture();
    const disabled = register(f, "register-disabled", { enabled: false });
    const enabled = register(f, "register-enabled");
    expect(disabled.control).toMatchObject({ version: 1, enabled: false });
    const options = execute(f, "listEvaluationModelRuntimeOptions", {
      actor: maintainer,
      repositoryId: f.repositoryId,
      query: {},
    });
    expect(options).toEqual({
      schemaVersion: "ModelRuntimeOptionsV1",
      repositoryId: f.repositoryId,
      page: 1,
      pageSize: 20,
      total: 1,
      items: [enabled.registration],
    });
    expect(
      execute(f, "listModelRuntimeRegistrations", {
        actor: administrator,
        query: { enabled: false },
      }).items.map((item) => item.registration.id),
    ).toEqual([disabled.registration.id]);
    control(f, enabled.registration.id);
    expect(
      execute(
        f,
        "listEvaluationModelRuntimeOptions",
        { actor: maintainer, repositoryId: f.repositoryId, query: {} },
        later,
      ).items,
    ).toEqual([]);
  });

  it("uses stable pagination and complete descending control history", () => {
    const f = fixture();
    const ids = [
      register(f, "registration-a"),
      register(f, "registration-b"),
      register(f, "registration-c"),
    ]
      .map((item) => item.registration.id)
      .sort()
      .reverse();
    const page = execute(f, "listModelRuntimeRegistrations", {
      actor: administrator,
      query: { page: 2, pageSize: 1 },
    });
    expect(page).toMatchObject({ total: 3, page: 2, pageSize: 1 });
    expect(page.items[0]?.registration.id).toBe(ids[1]);
    const selected = ids[0] as string;
    control(f, selected, 1, false, "control-two", later);
    control(f, selected, 2, true, "control-three", laterStill);
    const history = execute(
      f,
      "listModelRuntimeHistory",
      { actor: administrator, registrationId: selected, query: { page: 2, pageSize: 2 } },
      laterStill,
    );
    expect(history.total).toBe(3);
    expect(history.items.map((event) => event.version)).toEqual([1]);
    expect(
      execute(
        f,
        "listModelRuntimeHistory",
        { actor: administrator, registrationId: selected, query: { page: 3, pageSize: 2 } },
        laterStill,
      ).items,
    ).toEqual([]);
  });

  it("updates only control while immutable registration bytes and digest remain stable", () => {
    const f = fixture();
    const initial = register(f);
    const frozen = canonicalJson(initial.registration);
    const updated = control(f, initial.registration.id);
    expect(updated.registration).toEqual(initial.registration);
    expect(updated.control).toMatchObject({ version: 2, enabled: false, updatedAt: later });
    inRead(f.database, () => {
      expect(
        readModelRuntimeRegistrationInTransaction(f.database, initial.registration.id, {
          requireEnabled: true,
          now: later,
        }),
      ).toBeNull();
      const historical = readModelRuntimeRegistrationInTransaction(
        f.database,
        initial.registration.id,
        { now: later },
      );
      expect(historical?.registrationSha256).toBe(sha256(frozen));
      expect(canonicalJson(historical?.registration)).toBe(frozen);
    });
  });

  it("rejects stale CAS without adding audit, receipts, or changing control", () => {
    const f = fixture();
    const initial = register(f);
    control(f, initial.registration.id);
    const before = state(f.database);
    expect(() => control(f, initial.registration.id, 1, true, "stale-control", laterStill)).toThrow(
      expect.objectContaining({ code: "PLATFORM_CONFLICT" }),
    );
    expect(state(f.database)).toBe(before);
  });

  it("replays the original registration status after later control changes without applying it again", () => {
    const f = fixture();
    const first = register(f);
    control(f, first.registration.id);
    const before = state(f.database);
    expect(
      execute(
        f,
        "registerModelRuntime",
        { actor: administrator, request: registerRequest(), replayOnly: true },
        laterStill,
        { readOnly: true },
      ),
    ).toEqual(first);
    expect(state(f.database)).toBe(before);
    expect(
      execute(
        f,
        "getModelRuntimeRegistration",
        { actor: administrator, registrationId: first.registration.id },
        laterStill,
      ).control.enabled,
    ).toBe(false);
  });

  it("replays an exact historical control intent despite a newer current version", () => {
    const f = fixture();
    const first = register(f);
    const second = control(f, first.registration.id);
    control(f, first.registration.id, 2, true, "newer-control", laterStill);
    const before = state(f.database);
    expect(control(f, first.registration.id, 1, false, "change-control", laterStill)).toEqual(
      second,
    );
    expect(state(f.database)).toBe(before);
  });

  it.each(["transport", "owner"] as const)(
    "permits receipt replay but rejects new writes under %s read-only restriction",
    (kind) => {
      const f = fixture();
      const existing = register(f);
      const restriction = kind === "transport" ? { replayOnly: true as const } : {};
      const options = kind === "owner" ? { readOnly: true } : {};
      expect(
        execute(
          f,
          "registerModelRuntime",
          { actor: administrator, request: registerRequest(), ...restriction },
          later,
          options,
        ),
      ).toEqual(existing);
      const before = state(f.database);
      expect(() =>
        execute(
          f,
          "registerModelRuntime",
          { actor: administrator, request: registerRequest("new-change"), ...restriction },
          later,
          options,
        ),
      ).toThrow(expect.objectContaining({ code: "DATABASE_READ_ONLY" }));
      expect(state(f.database)).toBe(before);
    },
  );

  it.each(["name", "requestedModel", "identity", "enabled"] as const)(
    "rejects reuse of a registration change ID with altered %s",
    (field) => {
      const f = fixture();
      register(f);
      const changed = registerRequest();
      if (field === "name") changed.name = "Different synthetic registration";
      if (field === "requestedModel") changed.requestedModel = "other-model";
      if (field === "identity") changed.identity.modelId = "other-observed-model";
      if (field === "enabled") changed.enabled = false;
      const before = state(f.database);
      expect(() =>
        execute(f, "registerModelRuntime", { actor: administrator, request: changed }),
      ).toThrow(expect.objectContaining({ code: "PLATFORM_CONFLICT" }));
      expect(state(f.database)).toBe(before);
    },
  );

  it("binds receipt reuse to the exact actor, operation and registration", () => {
    const f = fixture();
    const first = register(f);
    const second = register(f, "register-second");
    const otherAdministrator = { ...administrator, subject: "other-administrator" };
    expect(() =>
      execute(
        f,
        "registerModelRuntime",
        { actor: otherAdministrator, request: registerRequest() },
        now,
        {},
        [administrator, otherAdministrator],
      ),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_CONFLICT" }));
    expect(() => control(f, first.registration.id, 1, false, "register-model")).toThrow(
      expect.objectContaining({ code: "PLATFORM_CONFLICT" }),
    );
    control(f, first.registration.id);
    expect(() => control(f, second.registration.id)).toThrow(
      expect.objectContaining({ code: "PLATFORM_CONFLICT" }),
    );
  });

  it.each(["viewer", "reviewer", "maintainer", "admin"] as const)(
    "does not turn repository %s into a platform registry administrator",
    (role) => {
      const f = fixture();
      setEvaluationManagementRole(f.database, f.repositoryId, role, 1);
      const first = register(f);
      const before = state(f.database);
      expect(() =>
        execute(f, "registerModelRuntime", {
          actor: maintainer,
          request: registerRequest("unprivileged"),
        }),
      ).toThrow(expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }));
      expect(() =>
        execute(f, "getModelRuntimeRegistration", {
          actor: maintainer,
          registrationId: first.registration.id,
        }),
      ).toThrow(expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }));
      expect(() =>
        execute(f, "listModelRuntimeHistory", {
          actor: maintainer,
          registrationId: first.registration.id,
          query: {},
        }),
      ).toThrow(expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }));
      if (role === "viewer" || role === "reviewer")
        expect(() =>
          execute(f, "listEvaluationModelRuntimeOptions", {
            actor: maintainer,
            repositoryId: f.repositoryId,
            query: {},
          }),
        ).toThrow(expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }));
      else
        expect(
          execute(f, "listEvaluationModelRuntimeOptions", {
            actor: maintainer,
            repositoryId: f.repositoryId,
            query: {},
          }).items,
        ).toHaveLength(1);
      expect(state(f.database)).toBe(before);
    },
  );

  it("requires current exact platform identity even for an old receipt", () => {
    const f = fixture();
    register(f);
    expect(() =>
      execute(
        f,
        "registerModelRuntime",
        { actor: administrator, request: registerRequest() },
        later,
        { readOnly: true },
        [],
      ),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }));
    expect(() =>
      execute(f, "listModelRuntimeRegistrations", {
        actor: { ...administrator, issuer: "https://other.example.invalid" },
        query: {},
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }));
  });

  it("rechecks repository existence, exact scope, and revoked configure access before exposing options", () => {
    const f = fixture();
    register(f);
    expect(() =>
      execute(f, "listEvaluationModelRuntimeOptions", {
        actor: maintainer,
        repositoryId: f.secondRepositoryId,
        query: {},
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
    expect(() =>
      execute(f, "listEvaluationModelRuntimeOptions", {
        actor: administrator,
        repositoryId: "missing-repository",
        query: {},
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
    setEvaluationManagementRole(f.database, f.repositoryId, null, 1);
    expect(() =>
      execute(f, "listEvaluationModelRuntimeOptions", {
        actor: maintainer,
        repositoryId: f.repositoryId,
        query: {},
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
  });

  it("requires a read transaction and preserves missing/disabled historical selection semantics", () => {
    const f = fixture();
    const created = register(f, "disabled", { enabled: false });
    expect(() =>
      readModelRuntimeRegistrationInTransaction(f.database, created.registration.id),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));
    inRead(f.database, () => {
      expect(readModelRuntimeRegistrationInTransaction(f.database, "missing-model")).toBeNull();
      expect(
        readModelRuntimeRegistrationInTransaction(f.database, created.registration.id, {
          requireEnabled: true,
        }),
      ).toBeNull();
      expect(
        readModelRuntimeRegistrationInTransaction(f.database, created.registration.id)
          ?.registration,
      ).toEqual(created.registration);
    });
    expect(() =>
      execute(f, "getModelRuntimeRegistration", {
        actor: administrator,
        registrationId: "missing-model",
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
  });

  it("rejects stored registrations or control timestamps from the future", () => {
    const f = fixture();
    const created = register(f);
    expect(() =>
      inRead(f.database, () =>
        readModelRuntimeRegistrationInTransaction(f.database, created.registration.id, {
          now: "2026-09-08T01:00:00.000Z",
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
    control(f, created.registration.id);
    expect(() =>
      inRead(f.database, () =>
        readModelRuntimeRegistrationInTransaction(f.database, created.registration.id, { now }),
      ),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
  });

  it.each(["identity_digest", "registration_digest", "noncanonical", "column"] as const)(
    "independently rejects corrupted %s without trusting stored digest claims",
    (kind) => {
      const f = fixture();
      const created = register(f);
      disableTableTriggers(f.database, "model_runtime_registrations");
      f.database.exec("PRAGMA ignore_check_constraints = ON");
      if (kind === "identity_digest") {
        const changed = structuredClone(created.registration);
        changed.identity.modelId = "changed-synthetic-model";
        const serialized = canonicalJson(changed);
        f.database
          .prepare(
            "UPDATE model_runtime_registrations SET registration_json = ?, registration_sha256 = ? WHERE id = ?",
          )
          .run(serialized, sha256(serialized), created.registration.id);
      } else if (kind === "registration_digest") {
        f.database
          .prepare("UPDATE model_runtime_registrations SET registration_sha256 = ? WHERE id = ?")
          .run("a".repeat(64), created.registration.id);
      } else if (kind === "noncanonical") {
        const serialized = JSON.stringify(created.registration, null, 2);
        f.database
          .prepare(
            "UPDATE model_runtime_registrations SET registration_json = ?, registration_sha256 = ? WHERE id = ?",
          )
          .run(serialized, sha256(serialized), created.registration.id);
      } else
        f.database
          .prepare("UPDATE model_runtime_registrations SET name = ? WHERE id = ?")
          .run("Changed outside the snapshot", created.registration.id);
      f.database.exec("PRAGMA ignore_check_constraints = OFF");
      expect(() =>
        execute(f, "getModelRuntimeRegistration", {
          actor: administrator,
          registrationId: created.registration.id,
        }),
      ).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
    },
  );

  it("refuses a control head without its immutable audit and does not silently hide it from list reads", () => {
    const f = fixture();
    const created = register(f);
    disableTableTriggers(f.database, "model_runtime_controls");
    f.database
      .prepare("UPDATE model_runtime_controls SET version = 2 WHERE registration_id = ?")
      .run(created.registration.id);
    expect(() =>
      execute(f, "getModelRuntimeRegistration", {
        actor: administrator,
        registrationId: created.registration.id,
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
    expect(() =>
      execute(f, "listModelRuntimeRegistrations", { actor: administrator, query: {} }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
  });

  it("validates the stored receipt digest before returning a claimed exact replay", () => {
    const f = fixture();
    register(f);
    disableTableTriggers(f.database, "model_runtime_mutation_receipts");
    f.database
      .prepare("UPDATE model_runtime_mutation_receipts SET response_sha256 = ? WHERE change_id = ?")
      .run("f".repeat(64), "register-model");
    expect(() => register(f)).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
  });

  it("rejects a control row rolled back behind a newer immutable audit", () => {
    const f = fixture();
    const created = register(f);
    control(f, created.registration.id);
    disableTableTriggers(f.database, "model_runtime_controls");
    f.database
      .prepare(
        "UPDATE model_runtime_controls SET version = 1, enabled = 1, updated_at = ? WHERE registration_id = ?",
      )
      .run(now, created.registration.id);
    expect(() =>
      execute(
        f,
        "getModelRuntimeRegistration",
        { actor: administrator, registrationId: created.registration.id },
        later,
      ),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
  });

  it.each([
    { identity: { ...identity(), unexpected: "not allowed" } },
    { requestedModel: " padded-model " },
    { name: "unsafe\u0000name" },
    { enabled: "true" },
    { identitySha256: "a".repeat(64) },
    { actor: administrator },
  ])("rejects malformed public registration input before writing: %j", (changes) => {
    const f = fixture();
    const before = state(f.database);
    expect(() =>
      execute(f, "registerModelRuntime", {
        actor: administrator,
        request: { ...registerRequest(), ...changes } as C.ModelRuntimeRegisterRequest,
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));
    expect(state(f.database)).toBe(before);
  });

  it("rejects extra options filters, unsafe page arithmetic and blank control reasons", () => {
    const f = fixture();
    const created = register(f);
    expect(() =>
      execute(f, "listEvaluationModelRuntimeOptions", {
        actor: maintainer,
        repositoryId: f.repositoryId,
        query: { enabled: false } as C.ModelRuntimeOptionsQuery,
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));
    expect(() =>
      execute(f, "listModelRuntimeRegistrations", {
        actor: administrator,
        query: { page: Number.MAX_SAFE_INTEGER, pageSize: 50 },
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));
    expect(() =>
      execute(f, "listModelRuntimeRegistrations", {
        actor: administrator,
        query: { pageSize: 51 },
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));
    expect(() =>
      execute(
        f,
        "changeModelRuntimeControl",
        {
          actor: administrator,
          registrationId: created.registration.id,
          request: { changeId: "blank-reason", expectedVersion: 1, enabled: false, reason: "  " },
        },
        later,
      ),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));
  });

  it("rolls back registration, initial control and audit if receipt persistence fails inside an outer transaction", () => {
    const f = fixture();
    const before = state(f.database);
    f.database.exec(
      "CREATE TEMP TRIGGER reject_synthetic_registry_receipt BEFORE INSERT ON model_runtime_mutation_receipts BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END;",
    );
    f.database.exec("BEGIN IMMEDIATE");
    expect(() => register(f)).toThrow("synthetic receipt failure");
    expect(f.database.isTransaction).toBe(true);
    expect(state(f.database)).toBe(before);
    f.database.exec("COMMIT");
    expect(state(f.database)).toBe(before);
  });

  it.each([
    "model_runtime_registrations",
    "model_runtime_audit",
    "model_runtime_mutation_receipts",
  ] as const)("enforces immutable update/delete/replace for %s at SQL boundaries", (table) => {
    const f = fixture();
    register(f);
    const before = state(f.database);
    expect(() =>
      f.database.exec(`UPDATE ${table} SET created_at = '2026-09-08T05:00:00.000Z'`),
    ).toThrow();
    expect(() => f.database.exec(`DELETE FROM ${table}`)).toThrow();
    expect(() =>
      f.database.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`),
    ).toThrow();
    expect(state(f.database)).toBe(before);
  });

  it("requires the matching audit to change control and rejects control deletion or replacement", () => {
    const f = fixture();
    const created = register(f);
    const before = state(f.database);
    expect(() =>
      f.database
        .prepare(
          "UPDATE model_runtime_controls SET enabled = 0, version = 2 WHERE registration_id = ?",
        )
        .run(created.registration.id),
    ).toThrow();
    expect(() => f.database.exec("DELETE FROM model_runtime_controls")).toThrow();
    expect(() =>
      f.database.exec(
        "INSERT OR REPLACE INTO model_runtime_controls SELECT * FROM model_runtime_controls",
      ),
    ).toThrow();
    expect(state(f.database)).toBe(before);
  });
});
