import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  assert(name?.startsWith("--") && value && !args.has(name), "Use distinct --name value pairs.");
  args.set(name, value);
}
const repoRoot = pathArgument("--repo-root");
const output = pathArgument("--output");
const capturedAt = args.get("--captured-at");
assert(
  capturedAt && Number.isFinite(Date.parse(capturedAt)),
  "--captured-at must be the actual API capture timestamp.",
);
const inputs = {};
for (const [name, argument] of [
  ["repository", "--repository-json"],
  ["issue", "--issue-json"],
  ["comments", "--comments-json"],
]) {
  const path = pathArgument(argument);
  const state = await lstat(path);
  assert(
    state.isFile() && !state.isSymbolicLink(),
    "Each raw input must be an ordinary captured JSON file.",
  );
  const bytes = await readFile(path);
  inputs[name] = { path, bytes, value: JSON.parse(bytes.toString("utf8")), sha256: hash(bytes) };
}
const rawRepository = object(inputs.repository.value, "repository");
const rawIssue = object(inputs.issue.value, "issue");
const rawComments = inputs.comments.value;
assert.equal(rawRepository.private, false, "Only an explicitly public API repository is eligible.");
const githubRepositoryId = positive(rawRepository.id, "repository.id");
const fullName = string(rawRepository.full_name, "repository.full_name");
assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(fullName));
assert.equal(rawRepository.html_url, `https://github.com/${fullName}`);
assert.equal(rawRepository.url, `https://api.github.com/repos/${fullName}`);
assert.equal(
  rawIssue.repository_url,
  rawRepository.url,
  "The captured Issue must belong to the captured repository.",
);
assert(
  rawIssue.pull_request === undefined,
  "Pull requests cannot be converted into Issue fixtures.",
);
const number = positive(rawIssue.number, "issue.number");
const upstreamIssueId = positive(rawIssue.id, "issue.id");
const url = `https://github.com/${fullName}/issues/${number}`;
assert.equal(rawIssue.html_url, url);
assert.equal(rawIssue.url, `https://api.github.com/repos/${fullName}/issues/${number}`);
assert(["open", "closed"].includes(rawIssue.state));
const title = string(rawIssue.title, "issue.title");
const body = markdown(rawIssue.body, "issue.body");
const updatedAt = string(rawIssue.updated_at, "issue.updated_at");
assert(Number.isFinite(Date.parse(updatedAt)));
assert(
  Array.isArray(rawComments),
  "--comments-json must contain all flattened raw comment pages as an array.",
);
assert.equal(
  rawComments.length,
  nonnegative(rawIssue.comments, "issue.comments"),
  "Incomplete or changed comment coverage must be recaptured, never silently truncated.",
);
const commentIds = new Set();
const comments = rawComments.map((entry) => {
  const comment = object(entry, "comment");
  const id = positive(comment.id, "comment.id");
  assert(!commentIds.has(id), "Flattened comment pages must not contain duplicate IDs.");
  commentIds.add(id);
  assert.equal(
    comment.issue_url,
    rawIssue.url,
    "A comment from another Issue cannot enter this frozen snapshot.",
  );
  return { id: `github-comment-${id}`, body: markdown(comment.body, "comment.body") };
});
const { investigationContentDigest: digest } = await import(
  pathToFileURL(join(repoRoot, "packages", "domain", "dist", "index.js")).href
);
const repository = { id: `github-repository-${githubRepositoryId}`, fullName, githubRepositoryId };
const workItemId = `github-issue-${upstreamIssueId}`;
const revisionKey = digest({
  repositoryId: githubRepositoryId,
  issueId: upstreamIssueId,
  number,
  title,
  body,
  state: rawIssue.state,
  updatedAt,
  comments,
});
const subject = {
  id: `issue-snapshot-${revisionKey}`,
  kind: "issue_snapshot",
  repositoryId: repository.id,
  workItemId,
  revisionKey,
  snapshotDigest: digest({ title, body, comments }),
};
const workItem = {
  id: workItemId,
  repositoryId: repository.id,
  kind: "issue",
  number,
  title,
  body,
  state: rawIssue.state,
  subject,
  updatedAt,
};
const inputSnapshot = {
  schemaVersion: "InvestigationInputSnapshotV1",
  repositoryId: repository.id,
  workItemId,
  subjectRef: subject.id,
  subjectRevisionKey: revisionKey,
  title,
  body,
  comments,
  source: null,
};
const fixture = {
  schemaVersion: "FrozenPublicIssueAcceptanceV1",
  capture: {
    url,
    capturedAt,
    repositoryVisibility: "public",
    readOnly: true,
    rawInputs: Object.fromEntries(
      Object.entries(inputs).map(([name, input]) => [
        name,
        { path: input.path, sha256: input.sha256, byteLength: input.bytes.length },
      ]),
    ),
    commentCount: comments.length,
    normalization:
      "Null Markdown bodies become empty strings; all captured text and comment order are otherwise retained.",
    latestUpstreamStateIndependentlyVerified: false,
  },
  repository,
  workItem,
  inputSnapshot,
};
const bytes = Buffer.from(`${JSON.stringify(fixture, null, 2)}\n`);
await writeFile(output, bytes, { flag: "wx" });
console.log(
  JSON.stringify({
    output,
    sha256: hash(bytes),
    issue: url,
    comments: comments.length,
    snapshotDigest: digest(inputSnapshot),
    networkRequests: 0,
  }),
);

function pathArgument(name) {
  const value = args.get(name);
  assert(value && isAbsolute(value), `${name} requires an absolute path.`);
  return resolve(value);
}
function object(value, name) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${name} must be a raw JSON object.`,
  );
  return value;
}
function positive(value, name) {
  assert(
    Number.isSafeInteger(value) && value > 0,
    `${name} must be a captured positive numeric ID.`,
  );
  return value;
}
function nonnegative(value, name) {
  assert(Number.isSafeInteger(value) && value >= 0, `${name} must be a non-negative integer.`);
  return value;
}
function string(value, name) {
  assert(typeof value === "string" && value.length > 0, `${name} must be captured non-empty text.`);
  return value;
}
function markdown(value, name) {
  assert(
    value === null || typeof value === "string",
    `${name} must be a captured Markdown string or null.`,
  );
  return value ?? "";
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
