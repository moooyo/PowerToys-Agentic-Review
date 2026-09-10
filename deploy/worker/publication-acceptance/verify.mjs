import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
await writeFile(
  receiptPath,
  `${JSON.stringify({ passed: true, transport: "synthetic fetch only", realGitHubWrites: 0, results }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
process.stdout.write("Synthetic publication outbox verification passed for both target kinds.\n");
