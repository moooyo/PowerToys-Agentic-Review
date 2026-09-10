import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as plan from "./plan.mjs";

// This verifier replaces fetch before constructing any transport. It cannot reach GitHub.
const [adapterPath, approvedDirectory, receiptPath] = process.argv.slice(2);
assert(adapterPath && approvedDirectory && receiptPath);
let handler;
globalThis.fetch = async (input, init) => {
  assert(handler, "No synthetic transport handler is installed.");
  return handler(new URL(String(input)), init);
};
const { preparePublication } = await import(pathToFileURL(adapterPath).href);
const results = [];
for (const kind of ["pull_request", "issue"]) {
  const pull = kind === "pull_request",
    number = pull ? 31 : 32;
  const snapshot = {
    id: pull ? 3031 : 3032,
    node_id: pull ? "PR_SYNTHETIC_VERIFY" : "I_SYNTHETIC_VERIFY",
    number,
    state: "open",
    title: pull ? plan.pullTitle : plan.issueTitle,
    body: pull ? plan.pullBody : plan.issueBody,
    html_url: `https://github.com/${plan.repository}/${pull ? "pull" : "issues"}/${number}`,
    created_at: "2026-09-10T00:00:00Z",
    updated_at: "2026-09-10T00:00:00Z",
    ...(pull ? { draft: true, base: { sha: plan.baseSha }, head: { sha: "c".repeat(40) } } : {}),
  };
  const endpoint = `/repos/${plan.repository}/${pull ? "pulls" : "issues"}/${number}`;
  const collection = `${endpoint}/${pull ? "reviews" : "comments"}`;
  const remote = [];
  const calls = [];
  handler = (url, init) => {
    assert.equal(url.origin, "https://api.github.com");
    calls.push({ method: init.method, path: url.pathname });
    if (init.method === "GET") {
      if (url.pathname === "/user") return Response.json({ id: plan.publisherId });
      if (url.pathname === `/repos/${plan.repository}`)
        return Response.json({ id: plan.repositoryId, full_name: plan.repository });
      if (url.pathname === endpoint) return Response.json(snapshot);
      if (url.pathname === collection) return Response.json(remote);
    }
    assert.equal(init.method, "POST");
    assert.equal(url.pathname, collection);
    assert.equal(remote.length, 0, "The synthetic endpoint must receive only one mutation.");
    const payload = JSON.parse(init.body);
    const item = {
      id: pull ? 9031 : 9032,
      user: { id: plan.publisherId },
      body: payload.body,
      ...(pull
        ? {
            commit_id: snapshot.head.sha,
            state: "COMMENTED",
            submitted_at: "2026-09-10T00:01:00Z",
            html_url: `${snapshot.html_url}#pullrequestreview-9031`,
          }
        : {
            created_at: "2026-09-10T00:01:00Z",
            html_url: `${snapshot.html_url}#issuecomment-9032`,
            issue_url: `https://api.github.com${endpoint}`,
          }),
    };
    remote.push(item);
    return Response.json(item, { status: pull ? 200 : 201 });
  };
  const fixture = await preparePublication(snapshot, kind, "c".repeat(40), {
    id: plan.repositoryId,
    full_name: plan.repository,
    node_id: "R_SYNTHETIC_ACCEPTANCE_REPOSITORY",
  });
  try {
    const template = await readFile(
      join(
        approvedDirectory,
        pull ? "pr-review-body.template.md" : "issue-comment-body.template.md",
      ),
      "utf8",
    );
    assert.equal(
      fixture.template,
      template,
      "Mechanical source and entity changes must preserve the approved body template.",
    );
    const result = await fixture.publish("synthetic-publication-token", template);
    assert.equal(result.publication.delivery.status, "published");
    assert.equal(result.postCount, 1);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(remote.length, 1);
    results.push({
      kind,
      fixtureDirectory: fixture.fixtureDirectory,
      delivery: result.publication.delivery,
      postCount: result.postCount,
      getCount: result.getCount,
      attempts: result.attempts,
    });
  } finally {
    await fixture.close();
  }
}
const coordinator = await verifyCoordinator();
await writeFile(
  receiptPath,
  `${JSON.stringify({ passed: true, transport: "synthetic fetch only", realGitHubWrites: 0, results, coordinator }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
process.stdout.write("Synthetic publication outbox and Actions safeguard verification passed.\n");

async function verifyCoordinator() {
  const root = `${receiptPath}.coordinator`;
  await mkdir(root, { recursive: false, mode: 0o700 });
  const scenarios = [
    { name: "normal" },
    ...["queued", "in_progress", "waiting", "requested", "pending", "unknown_status"].map(
      (status) => ({ name: `active-${status}`, status }),
    ),
    { name: "active-after-disable", afterDisable: "queued" },
    { name: "disable-readback-enabled", ignoreDisable: true },
    { name: "disabled-readback-omits-settings", omitDisabledFields: true },
    { name: "restored-readback-omits-settings", omitRestoredFields: true },
    { name: "lost-settings-acknowledgements", loseAcknowledgements: true },
    { name: "old-11-operation-plan", oldPlan: true },
  ];
  const summaries = [];
  for (const scenario of scenarios) {
    const directory = join(root, scenario.name);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    const tracePath = join(directory, "fetch.json");
    const preload = join(directory, "mock-fetch.mjs");
    await writeFile(
      preload,
      `import assert from "node:assert/strict";\nimport { writeFileSync } from "node:fs";\nimport { isMainThread } from "node:worker_threads";\nif (isMainThread) (${installCoordinatorFetch.toString()})(${JSON.stringify({ ...scenario, tracePath })}, ${JSON.stringify(plan)});\nelse globalThis.fetch = async () => { throw new Error("Network is disabled in synthetic verifier workers."); };\n`,
      { flag: "wx", mode: 0o600 },
    );
    let approval = approvedDirectory;
    if (scenario.oldPlan) {
      approval = join(directory, "old-approval");
      await mkdir(approval, { recursive: false, mode: 0o700 });
      const previous = JSON.parse(
        await readFile(join(approvedDirectory, "approval-plan.json"), "utf8"),
      );
      previous.schemaVersion = "PublicationAcceptancePlanV1";
      previous.operations = previous.operations.filter(
        (operation) => !["disable-actions", "restore-actions"].includes(operation.id),
      );
      delete previous.actions;
      delete previous.supersedes;
      assert.equal(previous.operations.length, 11);
      await writeFile(join(approval, "approval-plan.json"), JSON.stringify(previous), {
        flag: "wx",
        mode: 0o600,
      });
      for (const name of ["pr-review-body.template.md", "issue-comment-body.template.md"])
        await writeFile(join(approval, name), await readFile(join(approvedDirectory, name)), {
          flag: "wx",
          mode: 0o600,
        });
    }
    const output = join(directory, "output");
    const environment = { ...process.env };
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    const childResult = await new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [
          "--import",
          pathToFileURL(preload).href,
          fileURLToPath(new URL("./run.mjs", import.meta.url)),
          "--execute",
          "--credential-stdin",
          "--output",
          output,
          "--adapter",
          adapterPath,
          "--approved-directory",
          approval,
        ],
        { env: environment, timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) =>
          resolve({ code: error?.code ?? 0, signal: error?.signal ?? null, stdout, stderr }),
      );
      child.stdin.on("error", () => {});
      child.stdin.end("synthetic-coordinator-token\n");
    });
    await writeFile(
      join(directory, "child-output.log"),
      `${childResult.stdout}${childResult.stderr}`,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(directory, "child-exit.json"),
      JSON.stringify({ code: childResult.code, signal: childResult.signal }),
      { flag: "wx", mode: 0o600 },
    );
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    const receipt = JSON.parse(await readFile(join(output, "receipt.json"), "utf8"));
    const mutations = trace.calls.filter((call) => call.method !== "GET");
    assert(
      trace.calls.every((call) => !/\/(?:cancel|force-cancel|rerun)(?:\/|$)/u.test(call.path)),
      "The coordinator must never cancel or rerun workflows.",
    );
    assert.equal(childResult.signal, null, "The bounded coordinator child did not exit normally.");
    if (scenario.oldPlan) {
      assert.equal(childResult.code, 1);
      assert.equal(
        trace.calls.length,
        0,
        "An old approval must be rejected before any GitHub request.",
      );
    } else if (scenario.status) {
      assert.equal(childResult.code, 1);
      assert.deepEqual(mutations, []);
      assert.equal(receipt.actions.runChecks[0].runs.at(-1).status, scenario.status);
      assert.equal(
        receipt.actions.runChecks[0].runs.length,
        101,
        "The second workflow-run page must be inspected.",
      );
    } else if (scenario.afterDisable || scenario.ignoreDisable) {
      assert.equal(childResult.code, 1);
      assert.deepEqual(
        mutations.map((call) => call.operationId),
        scenario.ignoreDisable ? ["disable-actions"] : ["disable-actions", "restore-actions"],
      );
      if (scenario.afterDisable)
        assert.equal(receipt.actions.runChecks[1].runs.at(-1).status, scenario.afterDisable);
      else assert.equal(receipt.actions.disabled.enabled, true);
      assert.equal(receipt.publications.length, 0);
    } else {
      assert.equal(childResult.code, scenario.omitRestoredFields ? 1 : 0);
      if (scenario.omitRestoredFields) {
        assert.equal(receipt.failure.code, "ACCEPTANCE_FAILED");
        assert.equal(receipt.actions.restoration, "unconfirmed");
        assert.deepEqual(receipt.actions.final, { enabled: true });
      } else assert.equal(receipt.failure, null);
      assert.deepEqual(
        mutations.map((call) => call.operationId),
        plan.approvalPlan.operations.map((operation) => operation.id),
      );
      assert.equal(receipt.publications.length, 2);
      assert(receipt.publications.every((publication) => publication.postCount === 1));
      assert.deepEqual(
        receipt.actions.runChecks.map((check) => [check.phase, check.complete, check.runs.length]),
        [
          ["before_disable", true, 101],
          ["after_disable", true, 101],
        ],
      );
      const disable = trace.calls.findIndex((call) => call.operationId === "disable-actions");
      const create = trace.calls.findIndex((call) => call.operationId === "create-branch");
      const pages = trace.calls.flatMap((call, index) =>
        call.path.includes("/actions/runs?") ? [index] : [],
      );
      assert(pages[1] < disable && disable < pages[2] && pages[3] < create);
      assert(
        trace.calls
          .slice(disable + 1, pages[2])
          .some((call) => call.method === "GET" && call.path.endsWith("/actions/permissions")),
      );
      if (scenario.loseAcknowledgements) {
        assert.equal(receipt.actions.disableAcknowledged, false);
        assert.equal(receipt.actions.restoreAcknowledged, false);
        assert.equal(receipt.actions.restoration, "restored_from_readback");
      }
      if (scenario.omitDisabledFields)
        assert.deepEqual(receipt.actions.disabled, { enabled: false });
    }
    assert.deepEqual(
      receipt.cleanupFailures,
      scenario.omitRestoredFields ? ["restore-actions"] : [],
    );
    assert.deepEqual(
      trace.permissions,
      trace.initialPermissions,
      "All original Actions permission fields must be restored.",
    );
    for (const mutation of mutations.filter((call) => call.path.endsWith("/actions/permissions"))) {
      assert.equal(mutation.body.allowed_actions, plan.originalActionsPermissions.allowed_actions);
      assert.equal(
        mutation.body.sha_pinning_required,
        plan.originalActionsPermissions.sha_pinning_required,
      );
    }
    summaries.push({
      name: scenario.name,
      exitCode: childResult.code,
      mutationCount: mutations.length,
      directory,
    });
  }
  return summaries;
}

function installCoordinatorFetch(scenario, settings) {
  const root = `/repos/${settings.repository}`;
  const initialPermissions = {
    ...settings.originalActionsPermissions,
    selected_actions_url: `https://api.github.com${root}/actions/permissions/selected-actions`,
  };
  const state = {
    calls: [],
    initialPermissions,
    permissions: { ...initialPermissions },
    branch: null,
    hasIssues: false,
  };
  const commitSha = "c".repeat(40);
  const targets = Object.fromEntries(
    ["pull_request", "issue"].map((kind) => {
      const pull = kind === "pull_request",
        number = pull ? 31 : 32;
      return [
        kind,
        {
          id: pull ? 3031 : 3032,
          node_id: pull ? "PR_SYNTHETIC_COORDINATOR" : "I_SYNTHETIC_COORDINATOR",
          number,
          state: "open",
          title: pull ? settings.pullTitle : settings.issueTitle,
          body: pull ? settings.pullBody : settings.issueBody,
          html_url: `https://github.com/${settings.repository}/${pull ? "pull" : "issues"}/${number}`,
          created_at: "2026-09-10T00:00:00Z",
          updated_at: "2026-09-10T00:00:00Z",
          user: { id: settings.publisherId, login: settings.publisherLogin },
          ...(pull
            ? {
                draft: true,
                head: { sha: commitSha, ref: settings.branch, repo: { id: settings.repositoryId } },
                base: { sha: settings.baseSha, ref: "main", repo: { id: settings.repositoryId } },
              }
            : {}),
        },
      ];
    }),
  );
  const remote = { pull_request: [], issue: [] };
  const save = () =>
    writeFileSync(scenario.tracePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  save();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com", "No network fallback exists.");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer synthetic-coordinator-token",
    );
    const method = init?.method ?? "GET",
      path = url.pathname;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const call = { method, path: `${path}${url.search}`, ...(body === undefined ? {} : { body }) };
    state.calls.push(call);
    save();
    if (method === "GET") {
      if (path === "/user")
        return Response.json({ id: settings.publisherId, login: settings.publisherLogin });
      if (path === root)
        return Response.json({
          id: settings.repositoryId,
          full_name: settings.repository,
          node_id: "R_SYNTHETIC_COORDINATOR",
          has_issues: state.hasIssues,
          fork: true,
          archived: false,
        });
      if (path === `${root}/git/ref/heads/main`)
        return Response.json({ object: { sha: settings.baseSha } });
      if (path === `${root}/git/ref/heads/${settings.branch}`)
        return state.branch === null
          ? new Response(null, { status: 404 })
          : Response.json({ object: { sha: state.branch } });
      if (path === `${root}/actions/permissions`)
        return Response.json(
          scenario.omitRestoredFields &&
            state.permissions.enabled &&
            state.calls.some((entry) => entry.operationId === "restore-actions")
            ? { enabled: true }
            : scenario.omitDisabledFields && !state.permissions.enabled
              ? { enabled: false }
              : state.permissions,
        );
      if (path === `${root}/actions/runs`) {
        assert.equal(url.searchParams.get("per_page"), "100");
        const page = Number(url.searchParams.get("page"));
        assert(page === 1 || page === 2);
        const status =
          scenario.status ??
          (state.permissions.enabled ? "completed" : (scenario.afterDisable ?? "completed"));
        return Response.json({
          total_count: 101,
          workflow_runs:
            page === 1
              ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, status: "completed" }))
              : [{ id: 101, status }],
        });
      }
      for (const [kind, snapshot] of Object.entries(targets)) {
        const endpoint = `${root}/${kind === "pull_request" ? "pulls" : "issues"}/${snapshot.number}`;
        if (path === endpoint) return Response.json(snapshot);
        if (path === `${endpoint}/${kind === "pull_request" ? "reviews" : "comments"}`)
          return Response.json(remote[kind]);
      }
      assert.fail(`Unexpected synthetic GET: ${path}`);
    }
    const operation = settings.approvalPlan.operations.find(
      (candidate) =>
        candidate.method === method &&
        candidate.path.replace("{{NEW_PR_NUMBER}}", "31").replace("{{NEW_ISSUE_NUMBER}}", "32") ===
          path &&
        (path !== `${root}/actions/permissions` || candidate.body.enabled === body?.enabled) &&
        (path !== root || candidate.body.has_issues === body?.has_issues),
    );
    assert(operation, `Unexpected synthetic mutation: ${method} ${path}`);
    assert(
      !state.calls.slice(0, -1).some((prior) => prior.operationId === operation.id),
      "A mutation was retried.",
    );
    call.operationId = operation.id;
    save();
    if (!operation.id.startsWith("publish-"))
      assert.deepEqual(body ?? null, operation.body ?? null);
    if (path === `${root}/actions/permissions`) {
      if (!(scenario.ignoreDisable && !body.enabled)) Object.assign(state.permissions, body);
      save();
      if (scenario.loseAcknowledgements)
        throw new Error("Synthetic lost Actions settings acknowledgement.");
      return new Response(null, { status: 204 });
    }
    assert.equal(
      state.permissions.enabled,
      false,
      "Original operations require confirmed disabled Actions.",
    );
    if (operation.id === "create-branch") {
      state.branch = settings.baseSha;
      save();
      return Response.json({ ref: body.ref, object: { sha: state.branch } }, { status: 201 });
    }
    if (operation.id === "create-document-commit") {
      state.branch = commitSha;
      save();
      return Response.json(
        { content: { path: settings.documentPath }, commit: { sha: commitSha } },
        { status: 201 },
      );
    }
    if (operation.id === "create-draft-pr")
      return Response.json(targets.pull_request, { status: 201 });
    if (operation.id === "create-test-issue") return Response.json(targets.issue, { status: 201 });
    if (operation.id === "enable-issues" || operation.id === "restore-issues-disabled") {
      state.hasIssues = body.has_issues;
      save();
      return Response.json({ has_issues: state.hasIssues });
    }
    if (operation.id === "close-draft-pr" || operation.id === "close-test-issue") {
      const snapshot = operation.id === "close-draft-pr" ? targets.pull_request : targets.issue;
      snapshot.state = "closed";
      return Response.json(snapshot);
    }
    if (operation.id === "delete-test-branch") {
      state.branch = null;
      save();
      return new Response(null, { status: 204 });
    }
    const kind = operation.id === "publish-pr-review" ? "pull_request" : "issue";
    const snapshot = targets[kind],
      pull = kind === "pull_request";
    assert.equal(remote[kind].length, 0);
    assert.equal(typeof body.body, "string");
    assert(body.body.includes(settings.reportSummary));
    if (pull) {
      assert.equal(body.commit_id, commitSha);
      assert.equal(body.event, "COMMENT");
    }
    const item = {
      id: pull ? 9031 : 9032,
      user: { id: settings.publisherId },
      body: body.body,
      ...(pull
        ? {
            commit_id: commitSha,
            state: "COMMENTED",
            submitted_at: "2026-09-10T00:01:00Z",
            html_url: `${snapshot.html_url}#pullrequestreview-9031`,
          }
        : {
            created_at: "2026-09-10T00:01:00Z",
            html_url: `${snapshot.html_url}#issuecomment-9032`,
            issue_url: `https://api.github.com${root}/issues/${snapshot.number}`,
          }),
    };
    remote[kind].push(item);
    return Response.json(item, { status: pull ? 200 : 201 });
  };
}
