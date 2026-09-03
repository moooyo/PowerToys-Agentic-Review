import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  createAbsentServerBindingStateV1,
  reduceServerBindingStateV1,
  type ServerBindingImmutableBasisV1,
  type ServerBindingPhaseV1,
  type ServerBindingReceiptSnapshotV1,
  type ServerBindingRecordSnapshotV1,
  type ServerBindingRevocationSnapshotV1,
  type ServerBindingStateEventV1,
  type ServerBindingStateV1,
} from "./server-binding-state-v1.js";

const receipt = receiptSnapshot(p1363Signature(1));
const otherReceipt = receiptSnapshot(p1363Signature(2));
const record: ServerBindingRecordSnapshotV1 = { recordDocumentSha256: "7".repeat(64) };
const otherRecord: ServerBindingRecordSnapshotV1 = { recordDocumentSha256: "8".repeat(64) };

describe("server binding state v1", () => {
  it("follows the complete successful lifecycle and makes exact facts idempotent", () => {
    const absent = createAbsentServerBindingStateV1();
    expect(absent).toEqual({
      basis: null,
      phase: "absent",
      receipt: null,
      record: null,
      revocation: null,
    });
    expect(Object.isFrozen(absent)).toBe(true);

    const begin = beginEvent();
    const pending = reduceServerBindingStateV1(absent, begin);
    expect(pending.phase).toBe("signing_pending");
    expect(reduceServerBindingStateV1(pending, begin)).toBe(pending);

    const commit = commitEvent();
    const reserved = reduceServerBindingStateV1(pending, commit);
    expect(reserved.phase).toBe("reserved");
    expect(reduceServerBindingStateV1(reserved, begin)).toBe(reserved);
    expect(reduceServerBindingStateV1(reserved, commit)).toBe(reserved);

    const confirm = confirmEvent();
    const active = reduceServerBindingStateV1(reserved, confirm);
    expect(active.phase).toBe("active");
    expect(reduceServerBindingStateV1(active, begin)).toBe(active);
    expect(reduceServerBindingStateV1(active, commit)).toBe(active);
    expect(reduceServerBindingStateV1(active, confirm)).toBe(active);
    expectDeepFrozen(active);
  });

  it("rejects every forbidden lifecycle edge", () => {
    const absent = createAbsentServerBindingStateV1();
    const pending = pendingState();
    const reserved = reservedState();
    const active = activeState();

    for (const event of [
      commitEvent(),
      confirmEvent(),
      revokeEvent("signing_pending", null, null),
    ]) {
      expectCode(() => reduceServerBindingStateV1(absent, event), "TRANSITION_INVALID");
    }
    expectCode(() => reduceServerBindingStateV1(pending, confirmEvent()), "TRANSITION_INVALID");
    expectCode(
      () => reduceServerBindingStateV1(reserved, revokeEvent("active", receipt, record)),
      "REVOCATION_CONFLICT",
    );
    expectCode(
      () => reduceServerBindingStateV1(active, revokeEvent("reserved", receipt, null)),
      "REVOCATION_CONFLICT",
    );
  });

  it("pins every phase and event combination", () => {
    const pending = pendingState();
    const reserved = reservedState();
    const active = activeState();
    const terminalEvent = revokeEvent("active", receipt, record);
    const revoked = reduceServerBindingStateV1(active, terminalEvent);
    const cases: ReadonlyArray<{
      readonly event: ServerBindingStateEventV1;
      readonly outcome: ServerBindingPhaseV1 | "TERMINAL_REVOKED" | "TRANSITION_INVALID";
      readonly state: Readonly<ServerBindingStateV1>;
    }> = [
      {
        state: createAbsentServerBindingStateV1(),
        event: beginEvent(),
        outcome: "signing_pending",
      },
      {
        state: createAbsentServerBindingStateV1(),
        event: commitEvent(),
        outcome: "TRANSITION_INVALID",
      },
      {
        state: createAbsentServerBindingStateV1(),
        event: confirmEvent(),
        outcome: "TRANSITION_INVALID",
      },
      {
        state: createAbsentServerBindingStateV1(),
        event: revokeEvent("signing_pending", null, null),
        outcome: "TRANSITION_INVALID",
      },
      { state: pending, event: beginEvent(), outcome: "signing_pending" },
      { state: pending, event: commitEvent(), outcome: "reserved" },
      { state: pending, event: confirmEvent(), outcome: "TRANSITION_INVALID" },
      { state: pending, event: revokeEvent("signing_pending", null, null), outcome: "revoked" },
      { state: reserved, event: beginEvent(), outcome: "reserved" },
      { state: reserved, event: commitEvent(), outcome: "reserved" },
      { state: reserved, event: confirmEvent(), outcome: "active" },
      { state: reserved, event: revokeEvent("reserved", receipt, null), outcome: "revoked" },
      { state: active, event: beginEvent(), outcome: "active" },
      { state: active, event: commitEvent(), outcome: "active" },
      { state: active, event: confirmEvent(), outcome: "active" },
      { state: active, event: terminalEvent, outcome: "revoked" },
      { state: revoked, event: beginEvent(), outcome: "TERMINAL_REVOKED" },
      { state: revoked, event: commitEvent(), outcome: "TERMINAL_REVOKED" },
      { state: revoked, event: confirmEvent(), outcome: "TERMINAL_REVOKED" },
      { state: revoked, event: terminalEvent, outcome: "revoked" },
    ];
    for (const testCase of cases) {
      if (testCase.outcome === "TERMINAL_REVOKED" || testCase.outcome === "TRANSITION_INVALID") {
        expectCode(
          () => reduceServerBindingStateV1(testCase.state, testCase.event),
          testCase.outcome,
        );
      } else {
        expect(reduceServerBindingStateV1(testCase.state, testCase.event).phase).toBe(
          testCase.outcome,
        );
      }
    }
  });

  it("revokes each nonterminal retained binding state and permits only exact terminal replay", () => {
    const cases: ReadonlyArray<{
      phase: "signing_pending" | "reserved" | "active";
      state: Readonly<ServerBindingStateV1>;
      receipt: ServerBindingReceiptSnapshotV1 | null;
      record: ServerBindingRecordSnapshotV1 | null;
    }> = [
      { phase: "signing_pending", state: pendingState(), receipt: null, record: null },
      { phase: "reserved", state: reservedState(), receipt, record: null },
      { phase: "active", state: activeState(), receipt, record },
    ];

    for (const testCase of cases) {
      const event = revokeEvent(testCase.phase, testCase.receipt, testCase.record);
      const revoked = reduceServerBindingStateV1(testCase.state, event);
      expect(revoked.phase).toBe("revoked");
      expect(reduceServerBindingStateV1(revoked, event)).toBe(revoked);
      expectDeepFrozen(revoked);
      for (const later of [beginEvent(), commitEvent(), confirmEvent()]) {
        expectCode(() => reduceServerBindingStateV1(revoked, later), "TERMINAL_REVOKED");
      }
      expectCode(
        () =>
          reduceServerBindingStateV1(revoked, {
            ...event,
            revocation: { ...event.revocation, reasonCode: "integrity_failure" },
          }),
        "REVOCATION_CONFLICT",
      );
    }
  });

  it("rejects terminal replay drift in every retained field group", () => {
    const terminalEvent = revokeEvent("active", receipt, record);
    const revoked = reduceServerBindingStateV1(activeState(), terminalEvent);
    const driftBasis = validChangedBasis({ tuple: { workerNodeId: "windows-worker:002" } });
    const driftReceipt = receiptForBasis(driftBasis, p1363Signature(3));
    const cases: ReadonlyArray<readonly [ServerBindingStateEventV1, string]> = [
      [{ ...terminalEvent, basis: driftBasis, receipt: driftReceipt }, "IMMUTABLE_CONFLICT"],
      [{ ...terminalEvent, receipt: otherReceipt }, "RECEIPT_CONFLICT"],
      [{ ...terminalEvent, record: otherRecord }, "RECORD_CONFLICT"],
      [
        { ...terminalEvent, revocation: { ...terminalEvent.revocation, priorPhase: "reserved" } },
        "REVOCATION_CONFLICT",
      ],
      [
        {
          ...terminalEvent,
          revocation: { ...terminalEvent.revocation, reasonCode: "binding_compromised" },
        },
        "REVOCATION_CONFLICT",
      ],
      [
        {
          ...terminalEvent,
          revocation: {
            ...terminalEvent.revocation,
            revocationId: "a0000000-0000-4000-8000-00000000000a",
          },
        },
        "REVOCATION_CONFLICT",
      ],
      [
        {
          ...terminalEvent,
          revocation: { ...terminalEvent.revocation, revokedAt: "2026-09-03T10:02:00.000Z" },
        },
        "REVOCATION_CONFLICT",
      ],
    ];
    for (const [event, code] of cases) {
      expectCode(() => reduceServerBindingStateV1(revoked, event), code);
    }
  });

  it("serializes competing receipt and record candidates as first-wins compare-and-swap facts", () => {
    for (const [winner, loser] of [
      [receipt, otherReceipt],
      [otherReceipt, receipt],
    ] as const) {
      const first = reduceServerBindingStateV1(pendingState(), commitEvent(winner));
      expect(first.receipt).toEqual(winner);
      expectCode(() => reduceServerBindingStateV1(first, commitEvent(loser)), "RECEIPT_CONFLICT");
      expect(first.receipt).toEqual(winner);
    }

    const active = reduceServerBindingStateV1(reservedState(), confirmEvent(record, receipt));
    expect(active.record).toEqual(record);
    expectCode(
      () => reduceServerBindingStateV1(reservedState(), confirmEvent(record, otherReceipt)),
      "RECEIPT_CONFLICT",
    );
    expectCode(
      () => reduceServerBindingStateV1(active, commitEvent(otherReceipt)),
      "RECEIPT_CONFLICT",
    );
    expectCode(
      () => reduceServerBindingStateV1(active, confirmEvent(otherRecord, receipt)),
      "RECORD_CONFLICT",
    );
    expectCode(
      () => reduceServerBindingStateV1(active, confirmEvent(record, otherReceipt)),
      "RECEIPT_CONFLICT",
    );
  });

  it("rejects drift in every immutable basis group", () => {
    const pending = pendingState();
    const changes: ServerBindingImmutableBasisV1[] = [
      validChangedBasis({ tuple: { bindingId: "20000000-0000-4000-8000-000000000002" } }),
      validChangedBasis({ tuple: { certificateDerSha256: "9".repeat(64) } }),
      validChangedBasis({ tuple: { installationId: "installation-node-002" } }),
      validChangedBasis({ tuple: { workerNodeId: "windows-worker:002" } }),
      validChangedBasis({ issuer: { issuerKeyId: "a".repeat(64) } }),
      validChangedBasis({ boundAt: "2026-09-03T10:00:01.000Z" }),
      validChangedBasis({ request: { requestId: "request-002" } }),
      validChangedBasis({ request: { requestSha256: "c".repeat(64) } }),
      validChangedBasis({ request: { tokenSha256: "d".repeat(64) } }),
    ];
    for (const changed of changes) {
      expectCode(
        () => reduceServerBindingStateV1(pending, { type: "begin_signing", basis: changed }),
        "IMMUTABLE_CONFLICT",
      );
    }
  });

  it("rejects every identifier and signature class with trailing line terminators", () => {
    const terminators = [
      ["LF", "\n"],
      ["CR", "\r"],
      ["Unicode line separator", "\u2028"],
    ] as const;
    for (const [terminatorName, suffix] of terminators) {
      const signatureValue = `${p1363Signature(1)}${suffix}`;
      const signatureSnapshot = receiptForBasis(basis(), signatureValue);
      const asciiSignatureDocument = signatureSnapshot.canonicalJson.replaceAll(
        "\u2028",
        "\\u2028",
      );
      const actions: ReadonlyArray<readonly [string, () => unknown]> = [
        [
          "bindingId",
          () =>
            reduceServerBindingStateV1(createAbsentServerBindingStateV1(), {
              type: "begin_signing",
              basis: validChangedBasis({
                tuple: { bindingId: `${basis().tuple.bindingId}${suffix}` },
              }),
            }),
        ],
        [
          "sha256",
          () =>
            reduceServerBindingStateV1(createAbsentServerBindingStateV1(), {
              type: "begin_signing",
              basis: validChangedBasis({
                request: { requestSha256: `${basis().request.requestSha256}${suffix}` },
              }),
            }),
        ],
        [
          "entityId",
          () =>
            reduceServerBindingStateV1(createAbsentServerBindingStateV1(), {
              type: "begin_signing",
              basis: validChangedBasis({
                tuple: { workerNodeId: `${basis().tuple.workerNodeId}${suffix}` },
              }),
            }),
        ],
        [
          "package component",
          () =>
            reduceServerBindingStateV1(createAbsentServerBindingStateV1(), {
              type: "begin_signing",
              basis: validChangedBasis({
                tuple: { installationId: `${basis().tuple.installationId}${suffix}` },
              }),
            }),
        ],
        [
          "timestamp",
          () =>
            reduceServerBindingStateV1(createAbsentServerBindingStateV1(), {
              type: "begin_signing",
              basis: validChangedBasis({ boundAt: `${basis().statement.boundAt}${suffix}` }),
            }),
        ],
        [
          "signature",
          () =>
            reduceServerBindingStateV1(pendingState(), {
              type: "commit_receipt",
              basis: basis(),
              receipt: {
                canonicalJson: asciiSignatureDocument,
                receiptSha256: hash(asciiSignatureDocument),
              },
            }),
        ],
      ];
      for (const [fieldName, action] of actions) {
        expectCode(action, "EVENT_INVALID", `${fieldName} with trailing ${terminatorName}`);
      }
    }
  });

  it("copies input facts, deep-freezes output, and rejects accessors and extra fields", () => {
    const source = mutableBasis();
    const event = { type: "begin_signing" as const, basis: source };
    const pending = reduceServerBindingStateV1(createAbsentServerBindingStateV1(), event);
    source.tuple.workerNodeId = "windows-worker:changed";
    source.issuer.issuerKeyId = "f".repeat(64);
    source.statement.canonicalJson = '{"changed":true}';
    source.request.requestId = "request-changed";
    expect(pending.basis).toEqual(basis());
    expectDeepFrozen(pending);

    const receiptSource = { ...receipt };
    const reserved = reduceServerBindingStateV1(pending, commitEvent(receiptSource));
    receiptSource.canonicalJson = '{"changed":true}';
    receiptSource.receiptSha256 = "e".repeat(64);
    expect(reserved.receipt).toEqual(receipt);

    const recordSource = { ...record };
    const active = reduceServerBindingStateV1(reserved, confirmEvent(recordSource, receipt));
    recordSource.recordDocumentSha256 = "f".repeat(64);
    expect(active.record).toEqual(record);

    const revocationSource = { ...revokeEvent("active", receipt, record).revocation };
    const revoked = reduceServerBindingStateV1(active, {
      ...revokeEvent("active", receipt, record),
      revocation: revocationSource,
    });
    revocationSource.reasonCode = "integrity_failure";
    revocationSource.revokedAt = "2026-09-03T10:02:00.000Z";
    expect(revoked.revocation).toEqual(revokeEvent("active", receipt, record).revocation);
    expectDeepFrozen(revoked);

    let reads = 0;
    const accessorEvent = Object.defineProperties(
      {},
      {
        basis: { enumerable: true, value: basis() },
        type: {
          enumerable: true,
          get() {
            reads += 1;
            return "begin_signing";
          },
        },
      },
    );
    expectCode(
      () => reduceServerBindingStateV1(createAbsentServerBindingStateV1(), accessorEvent as never),
      "EVENT_INVALID",
    );
    expect(reads).toBe(0);
    expectCode(
      () =>
        reduceServerBindingStateV1(createAbsentServerBindingStateV1(), {
          ...beginEvent(),
          extra: true,
        } as never),
      "EVENT_INVALID",
    );
  });

  it("rejects mutable, structurally inconsistent, and malformed state or event facts", () => {
    expectCode(
      () => reduceServerBindingStateV1({ ...pendingState() }, beginEvent()),
      "STATE_INVALID",
    );
    const forged = Object.freeze({ ...pendingState(), phase: "active" as const });
    expectCode(() => reduceServerBindingStateV1(forged, beginEvent()), "STATE_INVALID");
    expectCode(
      () =>
        reduceServerBindingStateV1(createAbsentServerBindingStateV1(), {
          type: "begin_signing",
          basis: changedBasis({ tuple: { ...basis().tuple, bindingRevision: 2 as never } }),
        }),
      "EVENT_INVALID",
    );
    expectCode(
      () =>
        reduceServerBindingStateV1(createAbsentServerBindingStateV1(), {
          type: "begin_signing",
          basis: changedBasis({
            statement: { ...basis().statement, boundAt: "2026-02-30T00:00:00.000Z" },
          }),
        }),
      "EVENT_INVALID",
    );

    const arbitraryStatement = '{"statement":"unrelated"}';
    expectCode(
      () =>
        reduceServerBindingStateV1(createAbsentServerBindingStateV1(), {
          type: "begin_signing",
          basis: changedBasis({
            statement: {
              ...basis().statement,
              canonicalJson: arbitraryStatement,
              sha256: hash(arbitraryStatement),
            },
          }),
        }),
      "EVENT_INVALID",
    );

    const arbitraryReceipt = '{"receipt":"unrelated"}';
    expectCode(
      () =>
        reduceServerBindingStateV1(pendingState(), {
          type: "commit_receipt",
          basis: basis(),
          receipt: {
            canonicalJson: arbitraryReceipt,
            receiptSha256: hash(arbitraryReceipt),
          },
        }),
      "EVENT_INVALID",
    );

    expectCode(
      () =>
        reduceServerBindingStateV1(pendingState(), {
          type: "commit_receipt",
          basis: basis(),
          receipt: receiptForBasis(basis(), "A".repeat(86)),
        }),
      "EVENT_INVALID",
    );

    const unrelatedBasis = validChangedBasis({ tuple: { workerNodeId: "windows-worker:other" } });
    expectCode(
      () =>
        reduceServerBindingStateV1(pendingState(), {
          type: "commit_receipt",
          basis: basis(),
          receipt: receiptForBasis(unrelatedBasis, p1363Signature(4)),
        }),
      "EVENT_INVALID",
    );

    const genuineActive = activeState();
    const rehydratedActive = deepFreeze(
      JSON.parse(JSON.stringify(genuineActive)) as ServerBindingStateV1,
    );
    expect(rehydratedActive).toEqual(genuineActive);
    expectCode(() => reduceServerBindingStateV1(rehydratedActive, confirmEvent()), "STATE_INVALID");
  });

  it("closes reflection failures from event proxies and rejects state proxies before traps run", () => {
    let eventTraps = 0;
    const eventProxy = new Proxy(beginEvent(), {
      getPrototypeOf() {
        eventTraps += 1;
        throw new Error("event proxy trap");
      },
    });
    expectCode(
      () => reduceServerBindingStateV1(createAbsentServerBindingStateV1(), eventProxy),
      "EVENT_INVALID",
    );
    expect(eventTraps).toBe(1);

    let stateTraps = 0;
    const stateProxy = new Proxy(activeState(), {
      getPrototypeOf() {
        stateTraps += 1;
        throw new Error("state proxy trap");
      },
    });
    expectCode(() => reduceServerBindingStateV1(stateProxy, confirmEvent()), "STATE_INVALID");
    expect(stateTraps).toBe(0);
  });

  it("returns ordinary facts without a positive authority projection", () => {
    const states = [
      createAbsentServerBindingStateV1(),
      pendingState(),
      reservedState(),
      activeState(),
      reduceServerBindingStateV1(activeState(), revokeEvent("active", receipt, record)),
    ];
    const forbidden = /grant|authoriz|claim|execution|ready|slot|permit|capability|canrun/iu;
    for (const state of states) {
      const keys = collectKeys(state);
      expect(keys.filter((key) => forbidden.test(key))).toEqual([]);
      expect(Object.values(state).some((value) => typeof value === "boolean")).toBe(false);
    }
  });

  it("keeps the reducer dormant and its production dependency surface closed", () => {
    const testFile = fileURLToPath(import.meta.url);
    const moduleFile = resolve(dirname(testFile), "server-binding-state-v1.ts");
    const repositoryRoot = resolve(dirname(testFile), "../../../..");
    const consumers = productionSources(repositoryRoot)
      .filter((path) => path !== moduleFile)
      .filter((path) => /server-binding-state-v1/iu.test(readFileSync(path, "utf8")))
      .map((path) => relative(repositoryRoot, path).replaceAll("\\", "/"));
    expect(consumers).toEqual([]);

    const source = readFileSync(moduleFile, "utf8");
    const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)].map((match) => match[1]);
    expect(imports).toEqual(["node:crypto"]);
    expect(source).not.toMatch(/\b(?:require|import)\s*\(/u);
    expect(source).not.toMatch(
      /\b(?:database|sqlite|fastify|route|router|config(?:uration)?|network|socket|fetch|authentication|authorize|claim|execution|grant|permit|slot|capability)\b/iu,
    );
    expect(source).not.toMatch(
      /\b(?:readFile|writeFile|openSync|setTimeout|setInterval|queueMicrotask|randomBytes|randomUUID)\b|Math\.random/iu,
    );
    expect(source.replaceAll("workerNodeId", "")).not.toMatch(/worker/iu);
  });
});

function basis(): ServerBindingImmutableBasisV1 {
  const tuple = {
    bindingId: "10000000-0000-4000-8000-000000000001",
    bindingRevision: 1 as const,
    certificateDerSha256: "0".repeat(64),
    enrollmentGeneration: 1 as const,
    installationId: "installation-node-001",
    workerNodeId: "windows-worker:001",
  };
  const boundAt = "2026-09-03T10:00:00.000Z";
  const canonicalJson = statementDocument(tuple, boundAt);
  return {
    issuer: {
      algorithm: "ecdsa-p256-sha256-p1363-low-s",
      issuer: "agentic-review-server-enrollment-binding-authority-v1",
      issuerKeyId: "1".repeat(64),
      profileId: "agentic-review-server-binding-receipt-v1",
    },
    request: {
      requestId: "request-001",
      requestSha256: "2".repeat(64),
      tokenSha256: "3".repeat(64),
    },
    statement: {
      boundAt,
      canonicalJson,
      sha256: hash(canonicalJson),
    },
    tuple,
  };
}

function mutableBasis() {
  const value = basis();
  return {
    issuer: { ...value.issuer },
    request: { ...value.request },
    statement: { ...value.statement },
    tuple: { ...value.tuple },
  };
}

function changedBasis(
  overrides: Partial<ServerBindingImmutableBasisV1>,
): ServerBindingImmutableBasisV1 {
  return { ...basis(), ...overrides };
}

function validChangedBasis(options: {
  readonly boundAt?: string;
  readonly issuer?: Partial<ServerBindingImmutableBasisV1["issuer"]>;
  readonly request?: Partial<ServerBindingImmutableBasisV1["request"]>;
  readonly tuple?: Partial<ServerBindingImmutableBasisV1["tuple"]>;
}): ServerBindingImmutableBasisV1 {
  const original = basis();
  const tuple = { ...original.tuple, ...options.tuple };
  const boundAt = options.boundAt ?? original.statement.boundAt;
  const canonicalJson = statementDocument(tuple, boundAt);
  return {
    issuer: { ...original.issuer, ...options.issuer },
    request: { ...original.request, ...options.request },
    statement: { boundAt, canonicalJson, sha256: hash(canonicalJson) },
    tuple,
  };
}

function statementDocument(
  tuple: Readonly<ServerBindingImmutableBasisV1["tuple"]>,
  boundAt: string,
): string {
  return JSON.stringify({
    bindingId: tuple.bindingId,
    bindingRevision: tuple.bindingRevision,
    boundAt,
    certificateDerSha256: tuple.certificateDerSha256,
    enrollmentGeneration: tuple.enrollmentGeneration,
    installationId: tuple.installationId,
    statementType: "durable-binding-created",
    workerNodeId: tuple.workerNodeId,
  });
}

function receiptSnapshot(signatureValue: string): ServerBindingReceiptSnapshotV1 {
  return receiptForBasis(basis(), signatureValue);
}

function receiptForBasis(
  value: Readonly<ServerBindingImmutableBasisV1>,
  signatureValue: string,
): ServerBindingReceiptSnapshotV1 {
  const canonicalJson = JSON.stringify({
    algorithm: value.issuer.algorithm,
    issuer: value.issuer.issuer,
    issuerKeyId: value.issuer.issuerKeyId,
    profileId: value.issuer.profileId,
    schemaVersion: 1,
    signature: signatureValue,
    statement: JSON.parse(value.statement.canonicalJson) as unknown,
  });
  return { canonicalJson, receiptSha256: hash(canonicalJson) };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function p1363Signature(scalar: number): string {
  const bytes = Buffer.alloc(64);
  bytes[31] = scalar;
  bytes[63] = scalar;
  return bytes.toString("base64url");
}

function beginEvent(): Extract<ServerBindingStateEventV1, { readonly type: "begin_signing" }> {
  return { type: "begin_signing", basis: basis() };
}

function commitEvent(
  candidate = receipt,
): Extract<ServerBindingStateEventV1, { readonly type: "commit_receipt" }> {
  return { type: "commit_receipt", basis: basis(), receipt: candidate };
}

function confirmEvent(
  candidateRecord = record,
  candidateReceipt = receipt,
): Extract<ServerBindingStateEventV1, { readonly type: "confirm_record" }> {
  return {
    type: "confirm_record",
    basis: basis(),
    receipt: candidateReceipt,
    record: candidateRecord,
  };
}

function revokeEvent(
  priorPhase: ServerBindingRevocationSnapshotV1["priorPhase"],
  retainedReceipt: ServerBindingReceiptSnapshotV1 | null,
  retainedRecord: ServerBindingRecordSnapshotV1 | null,
): Extract<ServerBindingStateEventV1, { readonly type: "revoke" }> {
  return {
    type: "revoke",
    basis: basis(),
    receipt: retainedReceipt,
    record: retainedRecord,
    revocation: {
      priorPhase,
      reasonCode: "operator_requested",
      revocationId: "90000000-0000-4000-8000-000000000009",
      revokedAt: "2026-09-03T10:01:00.000Z",
    },
  };
}

function pendingState(): Readonly<ServerBindingStateV1> {
  return reduceServerBindingStateV1(createAbsentServerBindingStateV1(), beginEvent());
}

function reservedState(): Readonly<ServerBindingStateV1> {
  return reduceServerBindingStateV1(pendingState(), commitEvent());
}

function activeState(): Readonly<ServerBindingStateV1> {
  return reduceServerBindingStateV1(reservedState(), confirmEvent());
}

function expectCode(operation: () => unknown, code: string, message?: string): void {
  expect(operation, message).toThrowError(expect.objectContaining({ code }));
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) expectDeepFrozen(nested);
}

function collectKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const keys = Object.keys(value);
  return keys.concat(Object.values(value).flatMap((nested) => collectKeys(nested)));
}

function deepFreeze<T extends object>(value: T): Readonly<T> {
  for (const nested of Object.values(value)) {
    if (typeof nested === "object" && nested !== null) deepFreeze(nested);
  }
  return Object.freeze(value);
}

function productionSources(repositoryRoot: string): string[] {
  const result: string[] = [];
  const pending = [repositoryRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectory(entry.name)) pending.push(path);
        continue;
      }
      if (!entry.isFile() || ![".ts", ".tsx", ".mjs"].includes(extname(entry.name))) continue;
      const normalized = relative(repositoryRoot, path).replaceAll("\\", "/");
      if (
        /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/iu.test(normalized) ||
        /\.(?:test|spec|testing)\.(?:ts|tsx|mjs)$/iu.test(normalized)
      ) {
        continue;
      }
      result.push(path);
    }
  }
  return result;
}

function ignoredDirectory(name: string): boolean {
  return (
    name === ".git" ||
    name === "node_modules" ||
    name === "dist" ||
    name === "coverage" ||
    name === ".turbo"
  );
}
