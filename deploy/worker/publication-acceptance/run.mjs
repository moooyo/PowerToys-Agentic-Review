import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as plan from "./plan.mjs";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const credentialStdin = args.includes("--credential-stdin");
const value = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const result = args[index + 1];
  assert(result && !result.startsWith("--"), `${name} requires a value.`);
  return result;
};
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (["--execute", "--credential-stdin"].includes(argument)) continue;
  assert(["--output", "--adapter", "--approved-directory"].includes(argument), "Unknown argument.");
  assert(args[++index] && !args[index].startsWith("--"), "Missing option value.");
}
assert(!credentialStdin || execute, "Preparation never reads credentials.");
assert.equal(process.platform, "linux", "Run the production SQLite acceptance on Linux.");
const output = value("--output");
const adapterPath = value("--adapter");
assert(output && isAbsolute(output), "Use an exclusive absolute --output directory.");
assert(adapterPath && isAbsolute(adapterPath), "Provide the prepared local --adapter module.");
const approvedDirectory = value("--approved-directory");
assert(
  !execute || (approvedDirectory && isAbsolute(approvedDirectory)),
  "Execution requires the approved bundle directory.",
);
const { preparePublication } = await import(pathToFileURL(resolve(adapterPath)).href);
await mkdir(output, { recursive: false, mode: 0o700 });
const write = (name, object) =>
  writeFile(
    join(output, name),
    typeof object === "string" ? object : `${JSON.stringify(object, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
const filenames = {
  pull_request: "pr-review-body.template.md",
  issue: "issue-comment-body.template.md",
};
const receipt = {
  acceptanceId: plan.acceptanceId,
  mode: execute ? "execute" : "prepare",
  operations: [],
  publications: [],
  actions: { initial: null, disabled: null, final: null, runChecks: [], restoration: "not_needed" },
  cleanupFailures: [],
  failure: null,
};

function syntheticSnapshot(kind) {
  const pull = kind === "pull_request";
  const number = pull ? 1 : 2;
  return {
    id: pull ? 1001 : 1002,
    node_id: pull ? "PR_SYNTHETIC_ACCEPTANCE" : "I_SYNTHETIC_ACCEPTANCE",
    number,
    state: "open",
    title: pull ? plan.pullTitle : plan.issueTitle,
    body: pull ? plan.pullBody : plan.issueBody,
    html_url: `https://github.com/${plan.repository}/${pull ? "pull" : "issues"}/${number}`,
    created_at: "2026-09-10T00:00:00Z",
    updated_at: "2026-09-10T00:00:00Z",
    user: { id: plan.publisherId, login: plan.publisherLogin },
    ...(pull ? { draft: true, base: { sha: plan.baseSha }, head: { sha: "b".repeat(40) } } : {}),
  };
}

async function prepare() {
  const templates = {};
  for (const kind of ["pull_request", "issue"]) {
    const fixture = await preparePublication(syntheticSnapshot(kind), kind, "b".repeat(40));
    try {
      templates[kind] = fixture.template;
      await write(filenames[kind], fixture.template);
      await write(`${kind}-sample-preview.json`, fixture.preview);
      receipt.publications.push({
        kind,
        fixtureDirectory: fixture.fixtureDirectory,
        publicationId: fixture.preview.publicationId,
        bodyTemplate: filenames[kind],
        bodyTemplateSha256: plan.sha256(fixture.template),
      });
    } finally {
      await fixture.close();
    }
  }
  const approval = structuredClone(plan.approvalPlan);
  approval.operations.find((operation) => operation.id === "publish-pr-review").body.body =
    templates.pull_request;
  approval.operations.find((operation) => operation.id === "publish-issue-comment").body.body =
    templates.issue;
  approval.templates = templates;
  await write("approval-plan.json", approval);
  await write("document.md", plan.documentBody);
  await write("pull-request.md", plan.pullBody);
  await write("issue.md", plan.issueBody);
  await write(
    "document.patch",
    `diff --git a/${plan.documentPath} b/${plan.documentPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${plan.documentPath}\n@@ -0,0 +1,${plan.documentBody.trimEnd().split("\n").length} @@\n${plan.documentBody
      .trimEnd()
      .split("\n")
      .map((line) => `+${line}`)
      .join("\n")}\n`,
  );
}

async function executeApproved() {
  const approval = JSON.parse(
    await readFile(join(approvedDirectory, "approval-plan.json"), "utf8"),
  );
  assert.equal(approval.acceptanceId, plan.acceptanceId);
  assert.deepEqual(approval.repository, plan.approvalPlan.repository);
  assert.deepEqual(approval.document, plan.approvalPlan.document);
  assert.equal(approval.operations.length, 13);
  const approvedTemplates = {};
  for (const kind of ["pull_request", "issue"]) {
    approvedTemplates[kind] = await readFile(join(approvedDirectory, filenames[kind]), "utf8");
    assert.equal(approval.templates[kind], approvedTemplates[kind]);
  }
  const expectedOperations = structuredClone(plan.approvalPlan.operations);
  expectedOperations.find((operation) => operation.id === "publish-pr-review").body.body =
    approvedTemplates.pull_request;
  expectedOperations.find((operation) => operation.id === "publish-issue-comment").body.body =
    approvedTemplates.issue;
  assert.deepEqual(
    approval.operations,
    expectedOperations,
    "Approved operations differ from this fixed harness.",
  );
  assert.deepEqual(approval, {
    ...structuredClone(plan.approvalPlan),
    operations: expectedOperations,
    templates: approvedTemplates,
  });
  let token;
  if (credentialStdin) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      assert(bytes <= 16_384, "Credential input exceeds its bound.");
      chunks.push(Buffer.from(chunk));
    }
    token = Buffer.concat(chunks).toString("utf8").trim();
    for (const chunk of chunks) chunk.fill(0);
  } else {
    const result = await promisify(execFile)("gh", ["auth", "token", "--hostname", "github.com"], {
      timeout: 15_000,
      maxBuffer: 16_384,
      windowsHide: true,
    });
    token = result.stdout.trim();
  }
  assert(token && !/[\r\n]/u.test(token), "A single current-session GitHub token is required.");
  const performed = new Set();
  async function api(method, path, body, operationId) {
    assert(
      path === "/user" ||
        path.startsWith(`/repos/${plan.repository}/`) ||
        path === `/repos/${plan.repository}`,
    );
    if (method !== "GET") {
      assert(operationId && !performed.has(operationId), "A mutation cannot be retried.");
      performed.add(operationId);
    }
    const observation = { method, path, operationId: operationId ?? null, status: null };
    receipt.operations.push(observation);
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "agentic-review-publication-acceptance",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    observation.status = response.status;
    if (method === "GET" && response.status === 404) return null;
    assert(response.ok, `GitHub ${method} failed with status ${response.status}.`);
    if (response.status === 204) return null;
    const text = await response.text();
    assert(Buffer.byteLength(text) <= 8 * 1024 * 1024, "GitHub response exceeds its bound.");
    return JSON.parse(text);
  }
  const root = `/repos/${plan.repository}`;
  const user = await api("GET", "/user");
  assert.equal(user.id, plan.publisherId);
  assert.equal(user.login, plan.publisherLogin);
  const repository = await api("GET", root);
  assert.equal(repository.id, plan.repositoryId);
  assert.equal(repository.full_name, plan.repository);
  assert.equal(repository.has_issues, false);
  assert.equal(repository.fork, true);
  assert.equal(repository.archived, false);
  const baseline = await api("GET", `${root}/git/ref/heads/main`);
  assert.equal(baseline.object.sha, plan.baseSha);
  assert.equal(
    await api("GET", `${root}/git/ref/heads/${plan.branch}`),
    null,
    "The test branch already exists.",
  );
  const readActionsPermissions = async () => {
    const current = await api("GET", `${root}/actions/permissions`);
    const permissions = {
      enabled: current?.enabled,
      allowed_actions: current?.allowed_actions,
      sha_pinning_required: current?.sha_pinning_required,
    };
    assert.equal(typeof permissions.enabled, "boolean");
    return permissions;
  };
  const assertPreservedActionsPolicy = (permissions) => {
    for (const field of ["allowed_actions", "sha_pinning_required"])
      assert(
        permissions[field] === undefined ||
          permissions[field] === plan.originalActionsPermissions[field],
        "Actions permissions changed outside the approved scope.",
      );
  };
  const assertNoActiveActionsRuns = async (phase) => {
    const check = { phase, runs: [], complete: false };
    receipt.actions.runChecks.push(check);
    const ids = new Set();
    let total;
    for (let page = 1; page <= 100; page++) {
      const result = await api("GET", `${root}/actions/runs?per_page=100&page=${page}`);
      assert(
        Number.isSafeInteger(result?.total_count) &&
          result.total_count >= 0 &&
          result.total_count <= 10_000,
      );
      assert(Array.isArray(result.workflow_runs) && result.workflow_runs.length <= 100);
      if (total === undefined) total = result.total_count;
      assert.equal(result.total_count, total, "Workflow-run inventory changed during inspection.");
      for (const run of result.workflow_runs) {
        assert(Number.isSafeInteger(run.id) && run.id > 0 && !ids.has(run.id));
        ids.add(run.id);
        check.runs.push({ id: run.id, status: run.status });
        assert.equal(run.status, "completed", "An existing Actions run has not completed.");
      }
      if (ids.size === total) {
        check.complete = true;
        return;
      }
      assert(
        result.workflow_runs.length === 100 && ids.size < total,
        "Workflow-run inventory is incomplete.",
      );
    }
    throw new Error("Workflow-run inventory exceeded its page limit.");
  };
  receipt.actions.initial = await readActionsPermissions();
  assert.deepEqual(receipt.actions.initial, plan.originalActionsPermissions);
  await assertNoActiveActionsRuns("before_disable");
  let createdBranch = false,
    enabledIssues = false,
    actionsChangeAttempted = false,
    pull,
    issue,
    commitSha;
  const verify = (snapshot, kind) => {
    assert.equal(snapshot.state, "open");
    assert.equal(snapshot.user.id, plan.publisherId);
    assert.equal(snapshot.title, kind === "pull_request" ? plan.pullTitle : plan.issueTitle);
    assert.equal(snapshot.body, kind === "pull_request" ? plan.pullBody : plan.issueBody);
    assert.equal(
      snapshot.html_url,
      `https://github.com/${plan.repository}/${kind === "pull_request" ? "pull" : "issues"}/${snapshot.number}`,
    );
    if (kind === "pull_request") {
      assert.equal(snapshot.head.sha, commitSha);
      assert.equal(snapshot.base.sha, plan.baseSha);
      assert.equal(snapshot.head.ref, plan.branch);
      assert.equal(snapshot.base.ref, "main");
      assert.equal(snapshot.head.repo.id, plan.repositoryId);
      assert.equal(snapshot.base.repo.id, plan.repositoryId);
    } else {
      assert(!("pull_request" in snapshot));
    }
  };
  const mutate = async (id) => {
    const operation = plan.approvalPlan.operations.find((candidate) => candidate.id === id);
    assert(operation);
    const path = operation.path
      .replace("{{NEW_PR_NUMBER}}", String(pull?.number))
      .replace("{{NEW_ISSUE_NUMBER}}", String(issue?.number));
    return api(operation.method, path, operation.body ?? undefined, id);
  };
  try {
    actionsChangeAttempted = true;
    receipt.actions.disableAcknowledged = false;
    try {
      await mutate("disable-actions");
      receipt.actions.disableAcknowledged = true;
    } catch {
      // A lost settings acknowledgement is resolved by GET, never by a second PUT.
    }
    receipt.actions.disabled = await readActionsPermissions();
    assert.equal(receipt.actions.disabled.enabled, false);
    assertPreservedActionsPolicy(receipt.actions.disabled);
    await assertNoActiveActionsRuns("after_disable");
    const ref = await mutate("create-branch");
    assert.equal(ref.ref, `refs/heads/${plan.branch}`);
    assert.equal(ref.object.sha, plan.baseSha);
    createdBranch = true;
    const document = await mutate("create-document-commit");
    assert.equal(document.content.path, plan.documentPath);
    commitSha = document.commit.sha;
    assert(/^[a-f0-9]{40}$/u.test(commitSha));
    pull = await mutate("create-draft-pr");
    verify(pull, "pull_request");
    const updated = await mutate("enable-issues");
    assert.equal(updated.has_issues, true);
    enabledIssues = true;
    issue = await mutate("create-test-issue");
    verify(issue, "issue");
    await write("created-targets.json", {
      repository: plan.repository,
      branch: plan.branch,
      commitSha,
      pull,
      issue,
    });
    for (const [kind, snapshot] of [
      ["pull_request", pull],
      ["issue", issue],
    ]) {
      const current = await api(
        "GET",
        `${root}/${kind === "pull_request" ? "pulls" : "issues"}/${snapshot.number}`,
      );
      verify(current, kind);
      assert.equal(current.id, snapshot.id);
      const fixture = await preparePublication(current, kind, commitSha, repository);
      try {
        await write(`${kind}-preview.json`, fixture.preview);
        const result = await fixture.publish(token, approvedTemplates[kind]);
        await write(`${kind}-publication.json`, result);
        receipt.publications.push({
          kind,
          fixtureDirectory: fixture.fixtureDirectory,
          publicationId: fixture.preview.publicationId,
          postCount: result.postCount,
          getCount: result.getCount,
          remoteReceipt: result.publication.delivery.remoteReceipt,
        });
      } finally {
        await fixture.close();
      }
    }
  } finally {
    const cleanup = async (id, action) => {
      try {
        await action();
      } catch {
        receipt.cleanupFailures.push(id);
      }
    };
    if (pull)
      await cleanup("close-draft-pr", async () => {
        const current = await api("GET", `${root}/pulls/${pull.number}`);
        verify(current, "pull_request");
        assert.equal(current.id, pull.id);
        await mutate("close-draft-pr");
      });
    if (issue)
      await cleanup("close-test-issue", async () => {
        const current = await api("GET", `${root}/issues/${issue.number}`);
        verify(current, "issue");
        assert.equal(current.id, issue.id);
        await mutate("close-test-issue");
      });
    if (createdBranch)
      await cleanup("delete-test-branch", async () => {
        const current = await api("GET", `${root}/git/ref/heads/${plan.branch}`);
        assert.equal(current.object.sha, commitSha ?? plan.baseSha);
        await mutate("delete-test-branch");
      });
    if (enabledIssues)
      await cleanup("restore-issues-disabled", async () => {
        await mutate("restore-issues-disabled");
      });
    if (actionsChangeAttempted)
      await cleanup("restore-actions", async () => {
        receipt.actions.restoration = "unconfirmed";
        const current = await readActionsPermissions();
        if (current.enabled === plan.originalActionsPermissions.enabled) {
          receipt.actions.final = current;
          assert.deepEqual(current, plan.originalActionsPermissions);
          receipt.actions.restoration = "already_original";
          return;
        }
        assertPreservedActionsPolicy(current);
        receipt.actions.restoreAcknowledged = false;
        try {
          await mutate("restore-actions");
          receipt.actions.restoreAcknowledged = true;
        } catch {
          // Readback may confirm restoration even when its acknowledgement was lost.
        }
        receipt.actions.final = await readActionsPermissions();
        assert.deepEqual(receipt.actions.final, plan.originalActionsPermissions);
        receipt.actions.restoration = receipt.actions.restoreAcknowledged
          ? "restored"
          : "restored_from_readback";
      });
    token = undefined;
  }
  assert.equal(receipt.publications.length, 2);
  assert.deepEqual(receipt.cleanupFailures, []);
}

try {
  if (execute) await executeApproved();
  else await prepare();
} catch (error) {
  receipt.failure = {
    code: "ACCEPTANCE_FAILED",
    name: error instanceof Error ? error.name : "UnknownError",
  };
  if (!execute && error instanceof Error) receipt.failure.message = error.message;
  process.exitCode = 1;
} finally {
  await write("receipt.json", receipt);
  process.stdout.write(
    `${JSON.stringify({ mode: receipt.mode, output, passed: receipt.failure === null && receipt.cleanupFailures.length === 0 })}\n`,
  );
}
