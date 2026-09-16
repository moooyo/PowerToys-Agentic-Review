import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  assert(name?.startsWith("--") && value && !args.has(name), "Use distinct --name value pairs.");
  args.set(name, value);
}
assert.equal(
  process.platform,
  "win32",
  "Run this opt-in companion on the authorized Windows worker.",
);
assert(
  [undefined, "false", "true"].includes(args.get("--execute")),
  "--execute accepts only true or false.",
);
const executeRequested = args.get("--execute") === "true";
const repo = pathArgument("--repo-root");
const output = pathArgument("--output");
const draftPath = pathArgument("--draft");
const githubTokenPath = pathArgument("--github-token-path");
const approvalPath = args.has("--approval-receipt") ? pathArgument("--approval-receipt") : null;
assert(
  !inside(repo, output) && !inside(output, githubTokenPath),
  "Use a protected output directory outside source and keep the publisher token outside it.",
);
await ordinaryDirectory(repo);
await ordinaryDirectory(dirname(output));
let existingOutput = false;
try {
  await lstat(output);
  existingOutput = true;
  await ordinaryDirectory(output);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await mkdir(output);
}
const invocationId = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomBytes(3).toString("hex")}`;
const draftBytes = await readFile(draftPath);
const draft = JSON.parse(draftBytes.toString("utf8"));
const draftSha256 = sha256(draftBytes);
validateDraft(draft);
const repository = {
  id: "publication-repository-1299518756",
  fullName: "moooyo/PowerToys",
  githubRepositoryId: 1299518756,
};
const expectedGitHubUserId = 42196638;
const receipt = {
  schemaVersion: "NativeInvestigationPublicationReceiptV1",
  invocationId,
  runId: draft.runId,
  mode: executeRequested ? "execute" : "prepare",
  status: "running",
  startedAt: new Date().toISOString(),
  draftSha256,
  expectedGitHubUserId,
  repository,
  directGitHubWrites: 0,
  directOutboundPostCountObserved: false,
  postCountEvidence:
    "One persistent confirmation reservation per target and the production transport's single-mutation execution path establish an upper bound; GET readback separately counts created comments. No HTTP proxy or product test injection is used.",
  operations: [],
};
const statePath = join(output, "run-state.json");
const passwordPath = join(output, "server-admin-password.txt");
const state = existingOutput
  ? JSON.parse(await readFile(statePath, "utf8"))
  : {
      schemaVersion: "NativePublicationRunStateV1",
      runId: draft.runId,
      draftSha256,
      stage: "preparing",
      operations: [],
    };
assert.equal(state.schemaVersion, "NativePublicationRunStateV1");
assert.equal(state.runId, draft.runId);
assert.equal(state.draftSha256, draftSha256);
assert(
  ["preparing", "source_prepared_native_blocked", "prepared"].includes(state.stage),
  "This single-run state is already consumed. Inspect or reconcile its retained native receipt; do not start another run.",
);
let password;
if (existingOutput) password = await readFile(passwordPath, "utf8");
else {
  password = `publication-${randomBytes(24).toString("base64url")}`;
  await writeFile(passwordPath, password, { flag: "wx", mode: 0o600 });
  await saveState();
  await writeFile(join(output, "approved-scope-draft.json"), draftBytes, { flag: "wx" });
}
let githubToken;
let cookie = "";
let origin;
let server;
let approvalValidated = false;
let executionConsumed = false;
const streams = [];
const confirmDispatches = new Set();
const baseEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(?:SYSTEMROOT|WINDIR|COMSPEC|PATH|PATHEXT|TEMP|TMP)$/iu.test(key),
  ),
);

try {
  assert(
    !executeRequested || approvalPath,
    "External confirmation requires --approval-receipt as well as --execute true.",
  );
  if (approvalPath !== null) {
    const approvalBytes = await readFile(approvalPath);
    const approval = JSON.parse(approvalBytes.toString("utf8"));
    validateApproval(approval);
    approvalValidated = true;
    receipt.approval = {
      path: approvalPath,
      sha256: sha256(approvalBytes),
      approvedAt: approval.approvedAt,
      authorizationSource: approval.authorizationSource,
    };
  }
  const tokenState = await lstat(githubTokenPath);
  assert(
    tokenState.isFile() && !tokenState.isSymbolicLink(),
    "Use an explicit protected publisher-token file, not CLI authentication storage.",
  );
  githubToken = (await readFile(githubTokenPath, "utf8")).trim();
  assert(githubToken.length > 0 && !/[\r\n]/u.test(githubToken));
  const domain = await import(
    pathToFileURL(join(repo, "packages", "domain", "dist", "index.js")).href
  );
  const { InvestigationStore } = await import(
    pathToFileURL(join(repo, "apps", "server", "dist", "investigation", "store.js")).href
  );
  const serverEntry = join(repo, "apps", "server", "dist", "main.js");
  receipt.runtime = {};
  for (const [name, path] of Object.entries({
    serverEntry,
    nativeActions: join(repo, "apps", "server", "dist", "investigation", "actions.js"),
    nativeTransport: join(repo, "apps", "server", "dist", "investigation", "github-transport.js"),
    harness: fileURLToPath(import.meta.url),
    signalBridge: join(here, "ipc-signals.mjs"),
  })) {
    receipt.runtime[name] = { path, sha256: sha256(await readFile(path)) };
  }
  const initial = await preflightAll();
  await artifact("preflight-before.json", initial);
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  server = launch(serverEntry, {
    ...baseEnvironment,
    INVESTIGATION_HOST: "127.0.0.1",
    INVESTIGATION_PORT: String(port),
    INVESTIGATION_PUBLIC_ORIGIN: origin,
    INVESTIGATION_DATABASE_PATH: join(output, "investigation.sqlite"),
    INVESTIGATION_AUTH_DATABASE_PATH: join(output, "accounts.sqlite"),
    INVESTIGATION_DASHBOARD_DIRECTORY: join(repo, "apps", "dashboard", "dist"),
    INVESTIGATION_BOOTSTRAP_ADMIN_USERNAME: "publication-admin",
    INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD: password,
    INVESTIGATION_GITHUB_TOKEN_PATH: githubTokenPath,
    INVESTIGATION_GITHUB_USER_ID: String(expectedGitHubUserId),
    INVESTIGATION_WORKERS_JSON: "[]",
    INVESTIGATION_ENABLE_EXTERNAL_WRITES: approvalValidated ? "true" : "false",
  });
  await until(
    async () => {
      if (server.exit !== null) throw new Error("The production Server stopped before readiness.");
      try {
        return (
          await fetch(`${origin}/api/auth/session`, {
            redirect: "error",
            signal: AbortSignal.timeout(1_000),
          })
        ).ok;
      } catch {
        return false;
      }
    },
    "Server readiness",
    30_000,
  );
  await login();
  await configureAccount(false);
  const repositories = await localRequest("GET", "/api/repositories");
  const registered = repositories.items.find((entry) => entry.id === repository.id);
  if (registered === undefined) await localRequest("POST", "/api/repositories", repository);
  else assert.deepEqual(registered, repository);
  for (const operation of draft.operations) {
    const imported = await localRequest(
      "POST",
      `/api/repositories/${repository.id}/import-work-item`,
      { kind: operation.target.kind, number: operation.target.number },
    );
    const item = imported.workItem;
    assert.equal(item.repositoryId, repository.id);
    assert.equal(item.number, operation.target.number);
    assert.equal(item.kind, operation.target.kind);
    const context = await localRequest("GET", `/api/work-items/${item.id}/action-context`);
    assertContext(context, operation, item);
    const intentRequest = {
      idempotencyKey: operation.operationId,
      workItemId: item.id,
      action: "comment",
      subjectRef: item.subject.id,
      expectedRevisionKey: context.target.revisionKey,
      expectedHeadSha: context.target.headSha,
      reportRef: null,
      payload: operation.actionIntentPayload,
    };
    if (!approvalValidated) {
      assert.equal(
        state.operations.length,
        0,
        "Prepared native intents from an approved phase require the matching receipt to continue this companion.",
      );
      const material = {
        operationId: operation.operationId,
        nativeIntentCreated: false,
        nativePreparationBlocked:
          "The current production external-write gate also blocks external ActionIntent preparation.",
        intentRequest,
        githubRequest: operation.githubRequest,
        nativeMarkerRule: draft.nativeCorrelationMarker.construction,
      };
      state.preparationMaterials ??= [];
      state.preparationMaterials = [
        ...state.preparationMaterials.filter(
          (entry) => entry.operationId !== operation.operationId,
        ),
        material,
      ];
      await artifact(`${operation.sequence}-local-preparation.json`, {
        imported,
        context,
        ...material,
      });
      await saveState();
      continue;
    }
    const previous = state.operations.find((entry) => entry.operationId === operation.operationId);
    const intent =
      previous === undefined
        ? await localRequest("POST", "/api/action-intents", intentRequest)
        : await localRequest("GET", `/api/action-intents/${previous.intent.id}`);
    const prepared = validateIntent(
      intent,
      operation,
      item,
      context,
      domain.investigationContentDigest,
    );
    if (previous === undefined) state.operations.push(prepared);
    else assert.deepEqual(previous, prepared);
    await artifact(`${operation.sequence}-prepared-intent.json`, {
      imported,
      context,
      ...prepared,
    });
    await saveState();
  }
  assert.equal(approvalValidated ? state.operations.length : state.preparationMaterials?.length, 2);
  state.stage = approvalValidated ? "prepared" : "source_prepared_native_blocked";
  await saveState();
  if (!executeRequested) {
    const after = await preflightAll();
    await artifact("preflight-after-preparation.json", after);
    assert.deepEqual(
      after.targets.map((target) => target.commentIds),
      initial.targets.map((target) => target.commentIds),
    );
    receipt.status = approvalValidated
      ? "native_prepared_no_external_writes"
      : "local_materials_prepared_native_intent_blocked";
    receipt.operations = approvalValidated
      ? state.operations.map((entry) => ({
          operationId: entry.operationId,
          intentId: entry.intent.id,
          state: "prepared",
          confirmAttempts: 0,
          upstreamPostAttemptUpperBound: 0,
          expandedRequest: entry.expandedRequest,
        }))
      : state.preparationMaterials.map((entry) => ({
          ...entry,
          confirmAttempts: 0,
          upstreamPostAttemptUpperBound: 0,
        }));
  } else {
    assert(approvalValidated && approvalPath);
    const consumptionPath = join(dirname(approvalPath), `${draft.runId}.consumed.json`);
    await writeFile(
      consumptionPath,
      `${JSON.stringify({ schemaVersion: "PublicationApprovalConsumptionV1", runId: draft.runId, draftSha256, output, invocationId, startedAt: new Date().toISOString() }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    executionConsumed = true;
    state.stage = "execution_started";
    await saveState();
    await configureAccount(true);
    for (const operation of draft.operations) {
      await preflightRepository();
      const before = await preflightTarget(operation, true);
      const prepared = state.operations.find(
        (entry) => entry.operationId === operation.operationId,
      );
      const context = await localRequest(
        "GET",
        `/api/work-items/${prepared.intent.workItemId}/action-context`,
      );
      assert.equal(context.target.revisionKey, prepared.intent.expectedRevisionKey);
      assert.equal(context.target.headSha, prepared.intent.expectedHeadSha);
      assert.equal(context.target.state, "open");
      assert(
        context.fixedActions.some((entry) => entry.action === "comment" && entry.allowed),
        "The native current comment guard must permit this exact prepared action.",
      );
      await artifact(`${operation.sequence}-fresh-before-confirm.json`, {
        before,
        context,
        expandedRequest: prepared.expandedRequest,
      });
      let confirmed;
      try {
        confirmed = await localRequest(
          "POST",
          `/api/action-intents/${prepared.intent.id}/confirm`,
          { version: prepared.intent.version, payloadDigest: prepared.intent.payloadDigest },
        );
      } catch {
        // A lost local response cannot justify another confirmation or a replacement intent.
        confirmed = await localRequest("GET", `/api/action-intents/${prepared.intent.id}`);
      }
      for (
        let attempt = 0;
        attempt < 3 && ["unknown", "executing"].includes(confirmed.state);
        attempt += 1
      ) {
        await artifact(`${operation.sequence}-unknown-${attempt}.json`, confirmed);
        confirmed = await localRequest(
          "POST",
          `/api/action-intents/${prepared.intent.id}/reconcile`,
          {},
        );
        if (["unknown", "executing"].includes(confirmed.state)) await pause(1_000);
      }
      await artifact(`${operation.sequence}-native-result.json`, confirmed);
      const result = {
        operationId: operation.operationId,
        intentId: prepared.intent.id,
        confirmAttempts: prepared.confirmAttempts ?? 0,
        upstreamPostAttemptUpperBound: prepared.confirmAttempts ?? 0,
        nativeState: confirmed.state,
        nativeResult: confirmed.result,
      };
      receipt.operations.push(result);
      assert.equal(
        confirmed.state,
        "succeeded",
        "Failed or unresolved delivery consumes this run. Do not resend or create another intent.",
      );
      const after = await preflightTarget(operation, false);
      const matching = after.comments.filter(
        (comment) =>
          comment.body === prepared.expandedRequest.body.body &&
          comment.user.id === expectedGitHubUserId,
      );
      assert.equal(
        matching.length,
        1,
        "GET readback must identify exactly one matching native publication.",
      );
      assert.equal(String(matching[0].id), confirmed.result.externalId);
      assert.equal(
        after.comments.length,
        before.comments.length + 1,
        "The target must gain exactly one comment in this acceptance window.",
      );
      assert.deepEqual(
        after.commentIds.filter((id) => id !== matching[0].id),
        before.commentIds,
      );
      result.comment = {
        id: matching[0].id,
        url: matching[0].html_url,
        bodySha256: sha256(Buffer.from(matching[0].body)),
        createdCommentCount: 1,
        beforeCount: before.comments.length,
        afterCount: after.comments.length,
      };
      const exact = await githubGet(`/repos/moooyo/PowerToys/issues/comments/${matching[0].id}`);
      assert.equal(exact.body, prepared.expandedRequest.body.body);
      assert.equal(exact.user.id, expectedGitHubUserId);
      assert.equal(
        exact.issue_url,
        `https://api.github.com/repos/moooyo/PowerToys/issues/${operation.target.number}`,
      );
      await artifact(`${operation.sequence}-get-readback.json`, { before, after, exact });
    }
    assert.equal(confirmDispatches.size, 2);
    state.stage = "completed";
    await saveState();
    receipt.status = "passed";
  }
  await stopServer();
  const stored = new InvestigationStore(join(output, "investigation.sqlite"));
  try {
    const intents = stored.list("actionIntents");
    assert.equal(intents.length, approvalValidated ? 2 : 0);
    assert(
      intents.every(
        (intent) => intent.action === "comment" && intent.repositoryId === repository.id,
      ),
    );
    await artifact("closed-native-intents.json", intents);
  } finally {
    stored.close();
  }
} catch (error) {
  receipt.status = "failed";
  receipt.failure = safeError(error);
  process.exitCode = 1;
} finally {
  try {
    await stopServer();
  } catch (error) {
    receipt.status = "failed";
    receipt.cleanupFailure = safeError(error);
    process.exitCode = 1;
    if (server?.exit === null) {
      server.child.kill("SIGKILL");
      await Promise.race([server.closed, pause(5_000)]);
    }
  }
  for (const stream of streams) {
    try {
      await withDeadline(finished(stream), 10_000);
    } catch (error) {
      receipt.status = "failed";
      receipt.logFailure = safeError(error);
      process.exitCode = 1;
    }
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.confirmAttempts = confirmDispatches.size;
  receipt.upstreamPostAttemptUpperBound = confirmDispatches.size;
  await artifact("receipt.json", receipt);
  githubToken = undefined;
  console.log(
    JSON.stringify({
      status: receipt.status,
      mode: receipt.mode,
      receipt: join(output, `${invocationId}-receipt.json`),
    }),
  );
}

function validateDraft(value) {
  assert.equal(value.schemaVersion, "InvestigationPublicationApprovalDraftV1");
  assert.equal(value.runId, "investigation-publication-20260916-v1");
  assert.equal(value.repository.fullName, "moooyo/PowerToys");
  assert.equal(value.repository.githubRepositoryId, 1299518756);
  assert.equal(value.expectedGitHubPublisher.id, 42196638);
  assert.equal(value.executionScope.maximumRuns, 1);
  assert.equal(value.executionScope.intendedCommentCount, 2);
  assert.equal(value.executionScope.maximumGitHubPostAttempts, 2);
  assert.equal(value.executionScope.maximumPostAttemptsPerTarget, 1);
  assert.equal(value.executionScope.action, "comment");
  assert.equal(value.executionScope.directGhOrBrowserWritesAllowed, false);
  assert.equal(value.executionScope.automaticallyRetryFailedOrUnknownPosts, false);
  assert.equal(value.executionScope.approvalRequiredBeforeExternalWrites, true);
  assert.equal(value.executionScope.commentCleanupApproved, false);
  assert.equal(value.nativeCorrelationMarker.required, true);
  assert.equal(
    value.nativeCorrelationMarker.construction,
    "actionIntentPayload.body + two LF characters + <!-- agentic-review-action:<prepared intent id>:<prepared payloadDigest> -->",
  );
  assert.equal(value.operations.length, 2);
  for (const [index, number] of [3, 5].entries()) {
    const operation = value.operations[index];
    assert.equal(operation.sequence, index + 1);
    assert.equal(
      operation.operationId,
      `${value.runId}-${number === 3 ? "pr3" : "issue5"}-comment`,
    );
    assert.equal(operation.target.number, number);
    assert.equal(operation.target.kind, number === 3 ? "pull_request" : "issue");
    assert.deepEqual(operation.githubRequest, {
      method: "POST",
      path: `/repos/moooyo/PowerToys/issues/${number}/comments`,
      bodyField: "body",
      bodyConstruction:
        "The complete fixed actionIntentPayload.body below followed only by nativeCorrelationMarker. No drafts or additional text.",
    });
    assert.deepEqual(Object.keys(operation.actionIntentPayload).sort(), [
      "body",
      "drafts",
      "findingIds",
      "kind",
    ]);
    assert.equal(operation.actionIntentPayload.kind, "feedback");
    assert.deepEqual(operation.actionIntentPayload.findingIds, []);
    assert.deepEqual(operation.actionIntentPayload.drafts, []);
    assert.equal(operation.actionIntentPayload.body, fixedBody(number));
  }
}
function fixedBody(number) {
  const description = number === 3 ? "pull request conversation comment" : "issue comment";
  return (
    "Native Task/Report publication acceptance test.\n\nRun ID: `investigation-publication-20260916-v1`\n" +
    `Target: \`moooyo/PowerToys#${number}\` (${description}).\n\n` +
    "This comment tests the new investigation Server's prepared and confirmed ActionIntent comment delivery. It contains no code-review findings, approval recommendation, reproduction result, or product-quality conclusion. No maintainer response or action is needed."
  );
}
function validateApproval(value) {
  assert.equal(value.schemaVersion, "InvestigationPublicationUserApprovalV1");
  assert.equal(value.status, "approved");
  assert.equal(value.approvedDraftSha256, draftSha256);
  assert.equal(value.runId, draft.runId);
  assert.equal(value.approvedBy, "user");
  assert.equal(value.authorizationSource, "explicit-current-task-user-message");
  assert(typeof value.userApprovalText === "string" && value.userApprovalText.trim().length > 0);
  assert(Number.isFinite(Date.parse(value.approvedAt)));
  assert.equal(value.includesNativeMarkerRule, true);
  assert.equal(value.includesIncidentalAutomationEffects, true);
  assert.equal(value.maximumRuns, 1);
  assert.equal(value.maximumPostAttemptsPerTarget, 1);
  assert.deepEqual(
    value.operationIds,
    draft.operations.map((operation) => operation.operationId),
  );
}
function validateIntent(intent, operation, item, context, digest) {
  assert.equal(intent.state, "prepared");
  assert.equal(intent.action, "comment");
  assert.equal(intent.repositoryId, repository.id);
  assert.equal(intent.workItemId, item.id);
  assert.equal(intent.subjectRef, item.subject.id);
  assert.equal(intent.expectedRevisionKey, context.target.revisionKey);
  assert.equal(intent.expectedHeadSha, operation.target.headSha);
  assert.equal(intent.reportRef, null);
  assert.deepEqual(intent.payload, operation.actionIntentPayload);
  assert.equal(intent.payloadDigest, digest(operation.actionIntentPayload));
  assert(/^[A-Za-z0-9._:-]+$/u.test(intent.id) && /^[a-f0-9]{64}$/u.test(intent.payloadDigest));
  const nativeMarker = `<!-- agentic-review-action:${intent.id}:${intent.payloadDigest} -->`;
  assert(
    Buffer.byteLength(`${operation.actionIntentPayload.body}\n\n${nativeMarker}`, "utf8") <= 60_000,
  );
  return {
    operationId: operation.operationId,
    intent,
    nativeMarker,
    expandedRequest: {
      method: "POST",
      path: operation.githubRequest.path,
      body: { body: `${operation.actionIntentPayload.body}\n\n${nativeMarker}` },
    },
  };
}
function assertContext(context, operation, item) {
  assert.equal(context.repositoryId, repository.id);
  assert.equal(context.workItemId, item.id);
  assert.equal(context.target.kind, operation.target.kind);
  assert.equal(context.target.state, "open");
  assert.equal(context.target.headSha, operation.target.headSha);
  assert.equal(context.target.revisionKey, item.subject.revisionKey);
  assert.equal(context.reportRef, null);
}
async function preflightRepository() {
  const user = await githubGet("/user");
  assert.equal(user.id, expectedGitHubUserId);
  assert.equal(user.login, draft.expectedGitHubPublisher.login);
  const remote = await githubGet("/repos/moooyo/PowerToys");
  for (const [field, expected] of Object.entries({
    id: 1299518756,
    full_name: "moooyo/PowerToys",
    private: false,
    fork: true,
    archived: false,
    disabled: false,
    has_issues: true,
    default_branch: draft.repository.defaultBranch,
  }))
    assert.equal(remote[field], expected);
  assert.equal(remote.parent.full_name, draft.repository.parentFullName);
  const branch = await githubGet(
    `/repos/moooyo/PowerToys/git/ref/heads/${encodeURIComponent(draft.repository.defaultBranch)}`,
  );
  assert.equal(branch.object.sha, draft.repository.observedDefaultBranchSha);
  const permissions = await githubGet("/repos/moooyo/PowerToys/actions/permissions");
  assert.equal(permissions.enabled, draft.observedAutomationEffects.actionsEnabled);
  assert.equal(permissions.allowed_actions, draft.observedAutomationEffects.allowedActions);
  const ref = draft.repository.observedDefaultBranchSha;
  const workflows = await githubGet(
    `/repos/moooyo/PowerToys/contents/.github/workflows?ref=${ref}`,
  );
  assert(Array.isArray(workflows));
  assert.equal(
    workflows.filter((entry) => /\.ya?ml$/u.test(entry.name)).length,
    draft.observedAutomationEffects.workflowFilesInspected,
  );
  const workflow = draft.observedAutomationEffects.issueCommentWorkflow;
  const spelling = await githubGet(`/repos/moooyo/PowerToys/contents/${workflow.path}?ref=${ref}`);
  assert.equal(spelling.sha, workflow.gitBlobSha);
  assert.equal(spelling.encoding, "base64");
  const bytes = Buffer.from(spelling.content.replace(/\s/gu, ""), "base64");
  assert.equal(
    createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest("hex"),
    workflow.gitBlobSha,
  );
  return {
    user: { id: user.id, login: user.login },
    repository: remote,
    branch,
    permissions,
    workflows,
    spelling,
  };
}
async function preflightTarget(operation, requireOriginal) {
  const target = operation.target;
  const issue = await githubGet(`/repos/moooyo/PowerToys/issues/${target.number}`);
  assert.equal(issue.id, target.githubIssueResourceId ?? target.githubIssueId);
  assert.equal(issue.number, target.number);
  assert.equal(issue.title, target.title);
  assert.equal(issue.state, "open");
  assert.equal(issue.locked, false);
  assert.equal(issue.user.id, target.authorId);
  if (requireOriginal) assert.equal(issue.updated_at, target.observedUpdatedAt);
  let pull = null;
  if (target.kind === "pull_request") {
    pull = await githubGet("/repos/moooyo/PowerToys/pulls/3");
    assert.equal(pull.id, target.githubPullRequestId);
    assert.equal(pull.state, "open");
    assert.equal(pull.merged, false);
    assert.equal(pull.draft, target.draft);
    assert.equal(pull.base.sha, target.baseSha);
    assert.equal(pull.head.sha, target.headSha);
    assert.equal(pull.base.ref, target.baseRef);
    assert.equal(pull.head.ref, target.headRef);
    if (requireOriginal) assert.equal(pull.updated_at, target.observedUpdatedAt);
  } else assert.equal(issue.pull_request, undefined);
  const comments = [];
  for (let page = 1; page <= 100; page += 1) {
    const items = await githubGet(`${operation.githubRequest.path}?per_page=100&page=${page}`);
    assert(Array.isArray(items));
    comments.push(...items);
    if (items.length < 100) break;
    assert(page < 100, "Complete comment pagination exceeded its explicit read budget.");
  }
  assert.equal(new Set(comments.map((comment) => comment.id)).size, comments.length);
  for (const comment of comments)
    assert.equal(
      comment.issue_url,
      `https://api.github.com/repos/moooyo/PowerToys/issues/${target.number}`,
    );
  if (requireOriginal) {
    assert.equal(comments.length, target.observedConversationComments);
    assert(
      comments.every((comment) => !comment.body?.includes(draft.runId)),
      "This run ID is already present; another POST is prohibited.",
    );
    for (const prepared of state.operations)
      assert(
        comments.every((comment) => !comment.body?.includes(prepared.nativeMarker)),
        "This native intent marker is already present; do not resend.",
      );
  }
  return { issue, pull, comments, commentIds: comments.map((comment) => comment.id) };
}
async function preflightAll() {
  return {
    repository: await preflightRepository(),
    targets: await Promise.all(
      draft.operations.map((operation) => preflightTarget(operation, true)),
    ),
  };
}
async function githubGet(path) {
  assert(
    path === "/user" ||
      path.startsWith("/repos/moooyo/PowerToys/") ||
      path === "/repos/moooyo/PowerToys",
  );
  assert(!path.includes("..") && !path.includes("#") && !path.includes("://"));
  const response = await fetch(`https://api.github.com${path}`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "AgenticReview-Publication-Acceptance",
    },
  });
  assert(response.ok, `Read-only GitHub request ${path} returned HTTP ${response.status}.`);
  return response.json();
}
async function configureAccount(allowExecute) {
  const accounts = await localRequest("GET", "/api/accounts");
  const account = accounts.items.find((entry) => entry.username === "publication-admin");
  assert(account);
  assert(!allowExecute || (executeRequested && approvalValidated && executionConsumed));
  await localRequest("POST", `/api/accounts/${account.id}/update`, {
    version: account.version,
    displayName: "Native publication acceptance operator",
    enabled: true,
    isAdmin: true,
    repositoryIds: [repository.id],
    permissions: [
      "repository:manage",
      "action:prepare",
      ...(allowExecute ? ["action:execute"] : []),
    ],
    actionCapabilities: ["comment"],
    allowRepositoryExecution: false,
  });
  await login();
}
async function login() {
  const result = await localRequest(
    "POST",
    "/api/auth/login",
    { username: "publication-admin", password },
    true,
  );
  cookie = result.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  assert(cookie);
}
async function localRequest(method, path, body, raw = false) {
  assert(path.startsWith("/api/") && !path.includes("://"));
  if (path === "/api/action-intents") {
    assert(approvalValidated && method === "POST");
    assert.equal(body.action, "comment");
    assert(
      draft.operations.some(
        (operation) =>
          JSON.stringify(operation.actionIntentPayload) === JSON.stringify(body.payload),
      ),
    );
  }
  if (path.endsWith("/reconcile"))
    assert(executeRequested && approvalValidated && executionConsumed);
  const confirmation = /^\/api\/action-intents\/([A-Za-z0-9._:-]+)\/confirm$/u.exec(path);
  if (confirmation) {
    assert.equal(method, "POST");
    assert(executeRequested && approvalValidated && executionConsumed);
    const prepared = state.operations.find((entry) => entry.intent.id === confirmation[1]);
    assert(prepared && !confirmDispatches.has(prepared.intent.id) && !prepared.confirmAttempts);
    assert.deepEqual(body, {
      version: prepared.intent.version,
      payloadDigest: prepared.intent.payloadDigest,
    });
    assert(confirmDispatches.size < 2);
    confirmDispatches.add(prepared.intent.id);
    prepared.confirmAttempts = 1;
    await saveState();
  }
  const response = await fetch(`${origin}${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(90_000),
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(response.ok, `Local Server request ${method} ${path} returned HTTP ${response.status}.`);
  return raw ? { headers: response.headers, value: await response.json() } : response.json();
}
function launch(entry, environment) {
  const stdout = createWriteStream(join(output, `${invocationId}-server.stdout.log`), {
    flags: "wx",
  });
  const stderr = createWriteStream(join(output, `${invocationId}-server.stderr.log`), {
    flags: "wx",
  });
  streams.push(stdout, stderr);
  for (const stream of streams)
    stream.on("error", () => {
      receipt.logFailure = "A private Server log stream failed.";
    });
  const child = fork(entry, [], {
    cwd: repo,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: [
      "--enable-source-maps",
      "--import",
      pathToFileURL(join(here, "ipc-signals.mjs")).href,
    ],
  });
  const running = { child, exit: null, closed: null };
  running.closed = new Promise((resolveClosed) => {
    child.once("error", () => {
      running.exit = { error: "Server process startup failed." };
    });
    child.once("exit", (code, signal) => {
      running.exit = { code, signal };
    });
    child.once("close", resolveClosed);
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  receipt.serverPid = child.pid;
  return running;
}
async function stopServer() {
  if (!server) return;
  if (server.exit === null) {
    server.child.send({ type: "synthetic-acceptance-shutdown" });
    await until(async () => server.exit, "Server closure", 45_000);
  }
  await server.closed;
  assert.equal(server.exit.code, 0);
  receipt.serverExit = server.exit;
}
async function unusedPort() {
  const socket = createServer();
  await new Promise((ready, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", ready);
  });
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  return port;
}
async function saveState() {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
async function artifact(name, value) {
  await writeFile(join(output, `${invocationId}-${name}`), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}
async function until(predicate, label, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await pause(250);
  }
  throw new Error(`Timed out awaiting ${label}.`);
}
async function pause(ms) {
  await new Promise((done) => setTimeout(done, ms));
}
async function withDeadline(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Private log closure exceeded its deadline.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function pathArgument(name) {
  const value = args.get(name);
  assert(value && isAbsolute(value), `${name} requires an absolute path.`);
  return resolve(value);
}
function inside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
async function ordinaryDirectory(path) {
  const state = await lstat(path);
  assert(
    state.isDirectory() &&
      !state.isSymbolicLink() &&
      (await realpath(path)).toLowerCase() === path.toLowerCase(),
  );
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function safeError(error) {
  const raw = String(error?.message ?? error);
  return {
    name: error?.name ?? "Error",
    message: [githubToken, password]
      .filter(Boolean)
      .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), raw)
      .slice(0, 2_000),
  };
}
