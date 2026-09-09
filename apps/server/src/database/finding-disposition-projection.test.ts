import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { FindingOccurrenceKind } from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  currentRunFindingDispositionDigest,
  findingOccurrenceKey,
  findingResultDispositionDigest,
  initialFindingDisposition,
  readFindingDispositionProjection,
} from "./finding-disposition-projection.js";
import * as validationModelResultBinding from "./validation-model-result-binding.js";

const scope = { repositoryId: "repository-1", reviewRunId: "run-1" };
const revision = "a".repeat(64);
const planDigest = "b".repeat(64);
const executionDigest = "c".repeat(64);
const createdAt = "2026-09-07T01:00:00.000Z";
const updatedAt = "2026-09-07T02:00:00.000Z";
const actor = { issuer: "https://identity.example.test", subject: "reviewer-1" };
const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

interface ResultRef {
  readonly requestId: string;
  readonly jobId: string;
  readonly resultId: string;
  readonly resultDigest: string;
}

// Writable relational fixtures expose corruption that production triggers reject. Full migrated
// result admission and transaction lifecycle are covered by the persistence integration suite.
function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE review_runs(id TEXT PRIMARY KEY, repository_id TEXT, work_item_id TEXT,
      revision_id TEXT, revision_key TEXT, request_epoch_id TEXT, activation_id TEXT,
      plan_digest TEXT, request_count INTEGER, purpose TEXT DEFAULT 'review');
    CREATE TABLE review_run_requests(review_run_id TEXT, request_id TEXT, workflow_kind TEXT,
      target TEXT, required INTEGER, profile_version_id TEXT, prompt_version_id TEXT);
    CREATE TABLE review_run_job_links(review_run_id TEXT, request_id TEXT,
      activation_number INTEGER, job_id TEXT);
    CREATE TABLE jobs(id TEXT PRIMARY KEY, work_item_id TEXT, request_epoch_id TEXT,
      resource_revision TEXT, job_kind TEXT, status TEXT, attempt_count INTEGER,
      execution_digest TEXT);
    CREATE TABLE run_attempts(id TEXT PRIMARY KEY, job_id TEXT, attempt_number INTEGER,
      status TEXT, result_digest TEXT);
    CREATE TABLE validation_job_results(id TEXT PRIMARY KEY, result_digest TEXT,
      repository_id TEXT, review_run_id TEXT, request_id TEXT, job_id TEXT,
      run_attempt_id TEXT, work_item_id TEXT, revision_id TEXT, resource_revision TEXT,
      activation_id TEXT, job_activation INTEGER, plan_digest TEXT, schema_id TEXT,
      job_kind TEXT, workflow_kind TEXT, target TEXT, profile_version_id TEXT,
      prompt_version_id TEXT, execution_template_sha256 TEXT, result_json TEXT);
    CREATE TABLE finding_dispositions(result_id TEXT, result_digest TEXT, repository_id TEXT,
      review_run_id TEXT, request_id TEXT, job_id TEXT, kind TEXT, ordinal INTEGER,
      occurrence_key TEXT, state TEXT, version INTEGER, last_event_id TEXT, created_at TEXT,
      updated_at TEXT, updated_by_issuer TEXT, updated_by_subject TEXT);
    CREATE TABLE finding_disposition_events(id TEXT PRIMARY KEY, result_id TEXT,
      result_digest TEXT, repository_id TEXT, review_run_id TEXT, request_id TEXT, job_id TEXT,
      kind TEXT, ordinal INTEGER, occurrence_key TEXT, state TEXT, version INTEGER,
      previous_version INTEGER, previous_state TEXT, action TEXT, created_at TEXT,
      actor_issuer TEXT, actor_subject TEXT, reason TEXT);
    CREATE INDEX disposition_result ON finding_dispositions(result_id, kind, ordinal);
    CREATE INDEX event_occurrence ON finding_disposition_events(result_id, kind, ordinal, version);
  `);
  function insert(table: string, fields: Record<string, SQLInputValue>) {
    const names = Object.keys(fields);
    database
      .prepare(
        `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(fields));
  }
  function update(table: string, fields: Record<string, SQLInputValue>) {
    database
      .prepare(
        `UPDATE ${table} SET ${Object.keys(fields)
          .map((key) => `${key} = ?`)
          .join(", ")}`,
      )
      .run(...Object.values(fields));
  }
  insert("review_runs", {
    id: scope.reviewRunId,
    repository_id: scope.repositoryId,
    work_item_id: "item-1",
    revision_id: "revision-1",
    revision_key: revision,
    request_epoch_id: "epoch-1",
    activation_id: "activation-1",
    plan_digest: planDigest,
    request_count: 0,
  });
  function addRequest(requestId: string, required = true) {
    insert("review_run_requests", {
      review_run_id: scope.reviewRunId,
      request_id: requestId,
      workflow_kind: "pr_static_build",
      target: "headless",
      required: Number(required),
      profile_version_id: "profile-1",
      prompt_version_id: "prompt-1",
    });
    database.exec("UPDATE review_runs SET request_count = request_count + 1");
  }
  function addActivation(requestId: string, activationNumber = 1, status = "succeeded"): ResultRef {
    const jobId = `${requestId}-job-${activationNumber}`;
    const resultId = `${jobId}-result`;
    const resultDigest = sha256(resultId);
    insert("review_run_job_links", {
      review_run_id: scope.reviewRunId,
      request_id: requestId,
      activation_number: activationNumber,
      job_id: jobId,
    });
    insert("jobs", {
      id: jobId,
      work_item_id: "item-1",
      request_epoch_id: "epoch-1",
      resource_revision: revision,
      job_kind: "pull_request_review",
      status,
      attempt_count: status === "succeeded" ? 1 : 0,
      execution_digest: executionDigest,
    });
    if (status === "succeeded") {
      insert("run_attempts", {
        id: `${jobId}-attempt`,
        job_id: jobId,
        attempt_number: 1,
        status,
        result_digest: resultDigest,
      });
      insert("validation_job_results", {
        id: resultId,
        result_digest: resultDigest,
        repository_id: scope.repositoryId,
        review_run_id: scope.reviewRunId,
        request_id: requestId,
        job_id: jobId,
        run_attempt_id: `${jobId}-attempt`,
        work_item_id: "item-1",
        revision_id: "revision-1",
        resource_revision: revision,
        activation_id: "activation-1",
        job_activation: activationNumber,
        plan_digest: planDigest,
        schema_id: "ValidationJobResultV1",
        job_kind: "pull_request_review",
        workflow_kind: "pr_static_build",
        target: "headless",
        profile_version_id: "profile-1",
        prompt_version_id: "prompt-1",
        execution_template_sha256: executionDigest,
        result_json: '{"schemaVersion":"ValidationJobResultV1","private":"result body"}',
      });
    }
    return { requestId, jobId, resultId, resultDigest };
  }
  function addDisposition(
    result: ResultRef,
    ordinal = 0,
    kind: FindingOccurrenceKind = "pr_finding",
  ) {
    const occurrence = {
      resultId: result.resultId,
      resultDigest: result.resultDigest,
      kind,
      ordinal,
    };
    const key = findingOccurrenceKey(occurrence);
    const eventId = `${result.jobId}-${kind}-${ordinal}-event-1`;
    const shared = {
      result_id: result.resultId,
      result_digest: result.resultDigest,
      repository_id: scope.repositoryId,
      review_run_id: scope.reviewRunId,
      request_id: result.requestId,
      job_id: result.jobId,
      kind,
      ordinal,
      occurrence_key: key,
      state: "dismissed",
      version: 1,
    };
    insert("finding_disposition_events", {
      ...shared,
      id: eventId,
      previous_version: 0,
      previous_state: "open",
      action: "dismiss",
      created_at: createdAt,
      actor_issuer: actor.issuer,
      actor_subject: actor.subject,
      reason: "Reviewed the original immutable occurrence.",
    });
    insert("finding_dispositions", {
      ...shared,
      last_event_id: eventId,
      created_at: createdAt,
      updated_at: createdAt,
      updated_by_issuer: actor.issuer,
      updated_by_subject: actor.subject,
    });
    return { ...occurrence, key };
  }
  function reopen(result: ResultRef) {
    database
      .prepare(`INSERT INTO finding_disposition_events
      SELECT id || '-reopen', result_id, result_digest, repository_id, review_run_id,
        request_id, job_id, kind, ordinal, occurrence_key, 'open', 2, 1, state,
        'reopen', ?, actor_issuer, actor_subject, reason
      FROM finding_disposition_events WHERE result_id = ? AND version = 1`)
      .run(updatedAt, result.resultId);
    database
      .prepare(`UPDATE finding_dispositions SET state = 'open', version = 2,
      last_event_id = last_event_id || '-reopen', updated_at = ? WHERE result_id = ?`)
      .run(updatedAt, result.resultId);
  }
  function runDigest(query = scope) {
    database.exec("BEGIN");
    try {
      return currentRunFindingDispositionDigest(database, query);
    } finally {
      database.exec("ROLLBACK");
    }
  }
  addRequest("request-1");
  const result = addActivation("request-1");
  const resultScope = { resultId: result.resultId, resultDigest: result.resultDigest };
  return {
    database,
    result,
    resultScope,
    insert,
    update,
    addRequest,
    addActivation,
    addDisposition,
    reopen,
    runDigest,
    read: () => readFindingDispositionProjection(database, resultScope),
  };
}

function expectCorrupt(read: () => unknown) {
  expect(read).toThrowError(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
}

describe("finding disposition projection", () => {
  it("keeps untouched occurrences implicit and returns independent initial values", () => {
    const f = fixture();
    expect(f.read().size).toBe(0);
    expect(initialFindingDisposition()).toEqual({
      state: "open",
      version: 0,
      lastEventId: null,
      updatedAt: null,
      updatedBy: null,
    });
    expect(initialFindingDisposition()).not.toBe(initialFindingDisposition());
  });

  it("returns exact original occurrence identities and immutable event metadata", () => {
    const f = fixture();
    const pr = f.addDisposition(f.result, 7);
    const observation = f.addDisposition(f.result, 7, "validation_observation");
    const map = f.read();
    expect(map.size).toBe(2);
    expect(pr.key).not.toBe(observation.key);
    expect(map.get(pr.key)).toEqual({
      occurrence: pr,
      disposition: {
        state: "dismissed",
        version: 1,
        lastEventId: `${f.result.jobId}-pr_finding-7-event-1`,
        updatedAt: createdAt,
        updatedBy: actor,
      },
    });
    expect(map.get(observation.key)?.occurrence).toEqual(observation);
  });

  it.each([
    { resultId: "bad id", resultDigest: "d".repeat(64) },
    { resultId: "result-1", resultDigest: "D".repeat(64) },
    { resultId: "result-1", resultDigest: "d".repeat(63) },
    { resultId: "result-1", resultDigest: "d".repeat(64), unexpected: true },
  ])("rejects invalid result scopes %# before SQL", (query) => {
    const f = fixture();
    const prepare = vi.spyOn(f.database, "prepare");
    expect(() => readFindingDispositionProjection(f.database, query)).toThrowError(
      expect.objectContaining({ code: "PLATFORM_INVALID" }),
    );
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects absent results and mismatched exact result digests", () => {
    const f = fixture();
    expectCorrupt(() =>
      readFindingDispositionProjection(f.database, {
        ...f.resultScope,
        resultId: "missing-result",
      }),
    );
    expectCorrupt(() =>
      readFindingDispositionProjection(f.database, {
        ...f.resultScope,
        resultDigest: "d".repeat(64),
      }),
    );
  });

  it.each([
    ["repository_id", "another-repository"],
    ["review_run_id", "another-run"],
    ["request_id", "another-request"],
    ["job_id", "another-job"],
    ["result_digest", "d".repeat(64)],
    ["occurrence_key", "e".repeat(64)],
    ["kind", "unknown"],
    ["ordinal", 100],
    ["ordinal", -1],
    ["ordinal", 0.5],
    ["state", "unknown"],
    ["version", 0],
    ["version", 1.5],
    ["last_event_id", "missing-event"],
    ["created_at", "invalid-time"],
    ["updated_at", "invalid-time"],
    ["updated_by_issuer", "other-issuer"],
    ["updated_by_subject", "other-subject"],
  ] as const)("rejects a mismatched or malformed projection %s", (field, value) => {
    const f = fixture();
    f.addDisposition(f.result);
    f.update("finding_dispositions", { [field]: value });
    expectCorrupt(f.read);
  });

  it.each([
    ["result_id", "another-result"],
    ["result_digest", "d".repeat(64)],
    ["repository_id", "another-repository"],
    ["review_run_id", "another-run"],
    ["request_id", "another-request"],
    ["job_id", "another-job"],
    ["kind", "validation_observation"],
    ["ordinal", 1],
    ["occurrence_key", "e".repeat(64)],
    ["state", "resolved"],
    ["version", 2],
    ["previous_version", 1],
    ["previous_state", "dismissed"],
    ["action", "resolve"],
    ["created_at", updatedAt],
    ["actor_issuer", "other-issuer"],
    ["actor_subject", "other-subject"],
  ] as const)("rejects a projection whose last event has mismatched %s", (field, value) => {
    const f = fixture();
    f.addDisposition(f.result);
    f.update("finding_disposition_events", { [field]: value });
    expectCorrupt(f.read);
  });

  it.each([" issuer", "issuer ", "issuer\nname", "issuer\u007fname"])(
    "rejects invalid principals even when projection and event agree: %j",
    (issuer) => {
      const f = fixture();
      f.addDisposition(f.result);
      f.update("finding_dispositions", { updated_by_issuer: issuer });
      f.update("finding_disposition_events", { actor_issuer: issuer });
      expectCorrupt(f.read);
    },
  );

  it.each(["2026-09-07T01:00:00Z", "2026-09-07T03:00:00.000+02:00", "invalid-time"])(
    "rejects noncanonical event and projection timestamps: %s",
    (time) => {
      const f = fixture();
      f.addDisposition(f.result);
      f.update("finding_dispositions", { created_at: time, updated_at: time });
      f.update("finding_disposition_events", { created_at: time });
      expectCorrupt(f.read);
    },
  );

  it("rejects a forged but internally consistent occurrence key or result scope", () => {
    const f = fixture();
    f.addDisposition(f.result);
    for (const table of ["finding_dispositions", "finding_disposition_events"])
      f.update(table, { occurrence_key: "e".repeat(64) });
    expectCorrupt(f.read);
    const occurrence = { ...f.resultScope, kind: "pr_finding" as const, ordinal: 0 };
    for (const table of ["finding_dispositions", "finding_disposition_events"])
      f.update(table, {
        occurrence_key: findingOccurrenceKey(occurrence),
        repository_id: "other-repository",
      });
    expectCorrupt(f.read);
  });

  it("rejects a mismatched update time and a missing first event", () => {
    const f = fixture();
    f.addDisposition(f.result);
    f.reopen(f.result);
    expect(f.read().values().next().value?.disposition).toMatchObject({
      state: "open",
      version: 2,
    });
    f.update("finding_dispositions", { updated_at: createdAt });
    expectCorrupt(f.read);
    f.update("finding_dispositions", { updated_at: updatedAt });
    f.database.exec("DELETE FROM finding_disposition_events WHERE version = 1");
    expectCorrupt(f.read);
  });

  it("rejects reversed chronology even when both event timestamps match their projection", () => {
    const f = fixture();
    f.addDisposition(f.result);
    f.reopen(f.result);
    f.update("finding_dispositions", { created_at: updatedAt, updated_at: createdAt });
    f.database
      .prepare("UPDATE finding_disposition_events SET created_at = ? WHERE version = 1")
      .run(updatedAt);
    f.database
      .prepare("UPDATE finding_disposition_events SET created_at = ? WHERE version = 2")
      .run(createdAt);
    expectCorrupt(f.read);
  });

  it.each([
    ["accept", "accepted"],
    ["dismiss", "dismissed"],
    ["resolve", "resolved"],
  ])("accepts the explicit %s state transition", (action, state) => {
    const f = fixture();
    const occurrence = f.addDisposition(f.result);
    f.update("finding_dispositions", { state });
    f.update("finding_disposition_events", { state, action });
    expect(f.read().get(occurrence.key)?.disposition.state).toBe(state);
  });

  it("does not accept an old event while a later immutable event exists", () => {
    const f = fixture();
    f.addDisposition(f.result);
    f.reopen(f.result);
    f.update("finding_dispositions", {
      state: "dismissed",
      version: 1,
      updated_at: createdAt,
      last_event_id: `${f.result.jobId}-pr_finding-0-event-1`,
    });
    expectCorrupt(f.read);
  });

  it("rejects duplicate rows instead of silently overwriting the map", () => {
    const f = fixture();
    f.addDisposition(f.result);
    f.database.exec("INSERT INTO finding_dispositions SELECT * FROM finding_dispositions");
    expectCorrupt(f.read);
  });

  it("admits the 200 occurrence boundary and rejects a 201st returned projection row", () => {
    const f = fixture();
    for (const kind of ["pr_finding", "validation_observation"] as const)
      for (let ordinal = 0; ordinal < 100; ordinal++) f.addDisposition(f.result, ordinal, kind);
    expect(f.read().size).toBe(200);
    f.database.exec("INSERT INTO finding_dispositions SELECT * FROM finding_dispositions LIMIT 1");
    expectCorrupt(f.read);
  });

  it("keeps result digests deterministic while binding result identity and reopen receipts", () => {
    const f = fixture();
    const untouched = findingResultDispositionDigest(f.resultScope, f.read());
    f.addDisposition(f.result, 0);
    f.addDisposition(f.result, 1);
    const map = f.read();
    const recorded = findingResultDispositionDigest(f.resultScope, map);
    expect(recorded).not.toBe(untouched);
    expect(findingResultDispositionDigest(f.resultScope, new Map([...map].reverse()))).toBe(
      recorded,
    );
    expect(
      findingResultDispositionDigest({ ...f.resultScope, resultId: "other-result" }, map),
    ).not.toBe(recorded);
    f.reopen(f.result);
    const reopened = findingResultDispositionDigest(f.resultScope, f.read());
    expect(reopened).not.toBe(recorded);
    expect(reopened).not.toBe(untouched);
  });
});

describe("current run finding disposition digest", () => {
  it("binds V2 admission independently while retaining the immutable result digest basis", () => {
    const f = fixture();
    const before = f.runDigest();
    const admitted = vi
      .spyOn(
        validationModelResultBinding,
        "validateStoredValidationModelResultBindingInTransaction",
      )
      .mockReturnValue(null);
    f.update("validation_job_results", { schema_id: "ValidationJobResultV2" });
    expect(f.runDigest()).toBe(before);
    expect(admitted).toHaveBeenCalledWith(f.database, {
      ...f.resultScope,
      schemaId: "ValidationJobResultV2",
      repositoryId: scope.repositoryId,
      runId: scope.reviewRunId,
      requestId: f.result.requestId,
      jobId: f.result.jobId,
      runAttemptId: `${f.result.jobId}-attempt`,
      executionDigest,
    });
  });
  it("rejects a V2 result whose independent owner binding is unavailable", () => {
    const f = fixture();
    f.update("validation_job_results", { schema_id: "ValidationJobResultV2" });
    vi.spyOn(
      validationModelResultBinding,
      "validateStoredValidationModelResultBindingInTransaction",
    ).mockImplementation(() => {
      throw new Error("The owner invocation is unavailable.");
    });
    expectCorrupt(f.runDigest);
  });
  it("requires a transaction and validates run scope before any SQL", () => {
    const f = fixture();
    const prepare = vi.spyOn(f.database, "prepare");
    expect(() => currentRunFindingDispositionDigest(f.database, scope)).toThrowError(
      expect.objectContaining({ code: "PLATFORM_INVALID" }),
    );
    expect(() => f.runDigest({ ...scope, repositoryId: "bad id" })).toThrowError(
      expect.objectContaining({ code: "PLATFORM_INVALID" }),
    );
    expect(prepare).not.toHaveBeenCalled();
  });

  it("binds optional and missing requests, then selects their queued latest activation", () => {
    const f = fixture();
    const original = f.runDigest();
    f.addRequest("optional-request", false);
    const missing = f.runDigest();
    expect(missing).not.toBe(original);
    const old = f.addActivation("optional-request");
    const completed = f.runDigest();
    expect(completed).not.toBe(missing);
    f.addDisposition(old);
    const disposed = f.runDigest();
    expect(disposed).not.toBe(completed);
    const queued = f.addActivation("optional-request", 2, "queued");
    const latest = f.runDigest();
    expect(latest).not.toBe(disposed);
    f.reopen(old);
    expect(f.runDigest()).toBe(latest);
    expect(queued.jobId).not.toBe(old.jobId);
    f.addDisposition(f.result);
    expect(f.runDigest()).not.toBe(latest);
  });

  it("has a stable versioned envelope containing every request and current result identity", () => {
    const f = fixture();
    expect(f.runDigest()).toBe(
      sha256(
        canonicalJson({
          schemaVersion: "CurrentRunFindingDispositionsV1",
          ...scope,
          requests: [
            {
              requestId: f.result.requestId,
              workflowKind: "pr_static_build",
              target: "headless",
              required: true,
              jobId: f.result.jobId,
              activationNumber: 1,
              result: { ...f.resultScope, dispositions: [] },
            },
          ],
        }),
      ),
    );
  });

  it("ignores dispositions from a completed older activation after a newer result exists", () => {
    const f = fixture();
    f.addDisposition(f.result);
    const latest = f.addActivation(f.result.requestId, 2);
    const digest = f.runDigest();
    f.reopen(f.result);
    expect(f.runDigest()).toBe(digest);
    f.addDisposition(latest);
    const changed = f.runDigest();
    expect(changed).not.toBe(digest);
    f.reopen(latest);
    expect(f.runDigest()).not.toBe(changed);
    expect(f.runDigest()).not.toBe(digest);
  });

  it.each([
    ["review_runs", { request_count: 0 }],
    ["review_run_requests", { required: 2 }],
    ["review_run_requests", { request_id: "bad id" }],
    ["review_run_job_links", { activation_number: 0 }],
    ["review_run_job_links", { job_id: "missing-job" }],
    ["jobs", { work_item_id: "other-item" }],
    ["jobs", { request_epoch_id: "other-epoch" }],
    ["jobs", { resource_revision: "d".repeat(64) }],
    ["run_attempts", { result_digest: "d".repeat(64) }],
    ["run_attempts", { status: "failed" }],
    ["validation_job_results", { repository_id: "other-repository" }],
    ["validation_job_results", { request_id: "other-request" }],
    ["validation_job_results", { job_activation: 2 }],
    ["validation_job_results", { profile_version_id: "other-profile" }],
    ["validation_job_results", { execution_template_sha256: "d".repeat(64) }],
  ] satisfies [string, Record<string, SQLInputValue>][])(
    "rejects inconsistent current relational facts in %s %#",
    (table, fields) => {
      const f = fixture();
      f.update(table, fields);
      expectCorrupt(f.runDigest);
    },
  );

  it("rejects nonexistent runs, succeeded jobs without results, and duplicate requests", () => {
    const absent = fixture();
    expectCorrupt(() => absent.runDigest({ ...scope, reviewRunId: "missing-run" }));
    const missing = fixture();
    missing.database.exec("DELETE FROM validation_job_results");
    expectCorrupt(missing.runDigest);
    const duplicated = fixture();
    duplicated.database.exec("INSERT INTO review_run_requests SELECT * FROM review_run_requests");
    duplicated.update("review_runs", { request_count: 2 });
    expectCorrupt(duplicated.runDigest);
  });

  it("admits 32 requests and rejects the 33rd without silently truncating the plan", () => {
    const f = fixture();
    for (let index = 2; index <= 32; index++) f.addRequest(`request-${index}`, false);
    expect(f.runDigest()).toMatch(/^[a-f0-9]{64}$/u);
    f.addRequest("request-33", false);
    expectCorrupt(f.runDigest);
  });

  it("never selects heavyweight result JSON or audit reasons on either projection path", () => {
    const f = fixture();
    f.addDisposition(f.result);
    const before = f.runDigest();
    f.update("validation_job_results", {
      result_json: JSON.stringify({ private: "x".repeat(2 * 1024 * 1024) }),
    });
    f.update("finding_disposition_events", { reason: "private reason ".repeat(150_000) });
    const prepare = vi.spyOn(f.database, "prepare");
    const map = f.read();
    expect(f.runDigest()).toBe(before);
    expect(Buffer.byteLength(JSON.stringify([...map.values()]), "utf8")).toBeLessThan(2_048);
    const statements = prepare.mock.calls.map(([sql]) => sql);
    expect(statements.some((sql) => sql.includes("LIMIT 201"))).toBe(true);
    expect(statements.some((sql) => sql.includes("LIMIT 33"))).toBe(true);
    for (const sql of statements) {
      expect(sql).not.toMatch(/SELECT\s+\*/iu);
      expect(sql).not.toMatch(/\b(?:result_json|reason|policy_json|snapshot_json)\b/u);
    }
  });
});
