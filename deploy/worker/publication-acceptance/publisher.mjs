import assert from "node:assert/strict";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startPublicationPublisher } from "../../../apps/server/src/background/publication-publisher.js";
import {
  completion,
  createEvidenceControlPlaneFixture,
  uploadEvidence,
} from "../../../apps/server/src/database/evidence-control-plane.testing.js";
import { bindOperatorDatabase } from "../../../apps/server/src/database/operator-database.js";
import { GitHubPublicationClient } from "../../../apps/server/src/github/publication-client.js";
import { createPullRequestRevisionKey } from "../../../apps/server/src/github/revision-key.js";
import { canonicalJson } from "../../../apps/server/src/scheduling/canonical-json.js";
import {
  acceptanceId,
  baseSha,
  checkSummary,
  decisionReason,
  publisherId,
  publisherLogin,
  reportSummary,
  repository,
  repositoryId,
  sha256,
} from "./plan.mjs";

const actor = { issuer: "https://publication-acceptance.example.invalid", subject: acceptanceId };
const author = { githubUserId: publisherId, login: publisherLogin, accountType: "user" };

function sourceEvent(snapshot, kind, repositorySnapshot) {
  const now = new Date().toISOString();
  const common = {
    githubRepositoryId: repositoryId,
    githubWorkItemId: snapshot.id,
    observedAt: now,
    sourceUpdatedAt: snapshot.updated_at,
  };
  const revisionKey =
    kind === "pull_request"
      ? createPullRequestRevisionKey(snapshot.base.sha, snapshot.head.sha)
      : sha256(
          JSON.stringify([snapshot.title, snapshot.body, snapshot.state, snapshot.updated_at]),
        );
  return {
    contractVersion: 1,
    eventId: `${acceptanceId}-${kind}`,
    source: "webhook",
    sourceEventId: `${acceptanceId}-${kind}-synthetic-ingestion`,
    occurredAt: now,
    observedAt: now,
    repository: {
      githubRepositoryId: repositoryId,
      githubNodeId: repositorySnapshot?.node_id ?? "publication-acceptance-repository",
      ownerLogin: "moooyo",
      name: "PowerToys",
      fullName: repository,
      htmlUrl: `https://github.com/${repository}`,
      defaultBranch: "main",
      isPrivate: false,
    },
    author,
    actor: author,
    target: author,
    action: "request_opened",
    requestKind: kind === "pull_request" ? "review_request" : "assignment",
    workItem: {
      kind,
      githubRepositoryId: repositoryId,
      githubWorkItemId: snapshot.id,
      githubNodeId: snapshot.node_id,
      number: snapshot.number,
      title: snapshot.title,
      body: snapshot.body,
      state: "open",
      author,
      htmlUrl: snapshot.html_url,
      createdAt: snapshot.created_at,
      updatedAt: snapshot.updated_at,
      closedAt: null,
      ...(kind === "pull_request" ? { isDraft: snapshot.draft } : {}),
    },
    revision:
      kind === "pull_request"
        ? { ...common, kind, revisionKey, baseSha: snapshot.base.sha, headSha: snapshot.head.sha }
        : { ...common, kind, revisionKey, contentDigest: revisionKey },
  };
}

function confirmation(preview) {
  return {
    changeId: `${acceptanceId}-confirm`,
    publicationId: preview.publicationId,
    rendererVersion: preview.rendererVersion,
    expectedSelectedDecisionId: preview.binding.selectedDecisionId,
    expectedSelectedDecisionVersion: preview.binding.selectedDecisionVersion,
    expectedDecisionContextVersion: preview.binding.decisionContextVersion,
    expectedPolicyVersion: preview.policyVersion,
    expectedPublisherGitHubUserId: publisherId,
    expectedRevisionKey: preview.binding.revisionKey,
    expectedPlanDigest: preview.binding.planDigest,
    expectedResultSetDigest: preview.binding.resultSetDigest,
    expectedPayloadSha256: preview.payloadSha256,
  };
}

export async function preparePublication(
  snapshot,
  kind,
  testedSourceSha = baseSha,
  repositorySnapshot,
) {
  assert.equal(process.platform, "linux", "The production SQLite owner requires Linux.");
  const fixture = await createEvidenceControlPlaneFixture(1, [actor], {
    publicationPublisher: { githubUserId: publisherId },
    syntheticSource: {
      event: sourceEvent(snapshot, kind, repositorySnapshot),
      ...(kind === "issue" ? { testedSourceSha } : {}),
    },
  });
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await fixture.closeOwner();
    }
  };
  try {
    const envelope = (await fixture.claimAll())[0];
    assert(envelope, "The fixture requires one actual database lease.");
    const evidenceId = await uploadEvidence(fixture, envelope, "publication-fixture-log", 256);
    const completed = completion(envelope, [evidenceId]);
    completed.result.report.summary = reportSummary;
    for (const check of completed.result.report.checks) {
      check.outcome = "failed";
      check.summary = checkSummary;
      check.expected = "Synthetic fixture success";
      check.actual = "Deliberate synthetic failure; no application command was run.";
    }
    for (const diagnostic of completed.result.execution.diagnostics) {
      diagnostic.outcome = "failed";
      diagnostic.exitCode = 1;
      diagnostic.summary = checkSummary;
    }
    if (kind === "issue") {
      completed.result.report.workItemKind = "issue";
      completed.result.report.reproductionConclusion = "inconclusive";
    }
    completed.resultDigest = sha256(canonicalJson(completed.result));
    await fixture.client.request("completeLease", completed);
    const database = bindOperatorDatabase(fixture.client, actor);
    const query = { ...fixture.query, actor };
    await database.request("updateRepositoryPublicationPolicy", {
      repositoryId: fixture.query.repositoryId,
      actor,
      changeId: `${acceptanceId}-enable-publication`,
      expectedVersion: 0,
      enabled: true,
    });
    const context = await database.request("getReviewRunDecisionContext", query);
    const decision = (
      await database.request("changeReviewRunDecision", {
        ...query,
        changeId: `${acceptanceId}-comment`,
        action: "comment",
        reason: decisionReason,
        expectedVersion: context.version,
        expectedRevisionKey: context.revisionKey,
        expectedPlanDigest: context.planDigest,
        expectedResultSetDigest: context.resultSetDigest,
      })
    ).change;
    let preview;
    const deadline = Date.now() + 15_000;
    do {
      preview = await database.request("getPublicationPreview", {
        ...query,
        decisionId: decision.id,
      });
      if (!preview.blockers.includes("evidence_unavailable")) break;
      await delay(100);
    } while (Date.now() < deadline);
    assert.deepEqual(preview.blockers, [], "The production preview must be available.");
    assert(preview.payload && preview.semanticSha256 && preview.payloadSha256);
    const result = await database.request("getDashboardReviewRunJobResult", {
      ...fixture.query,
      requestId: envelope.validation.requestId,
      jobId: envelope.job.jobId,
    });
    const substitutions = new Map([
      [String(snapshot.number), "NEW_WORK_ITEM_NUMBER"],
      [preview.binding.reviewRunId, "REVIEW_RUN_ID"],
      [preview.binding.revisionKey, "REVISION_KEY"],
      [kind === "pull_request" ? snapshot.head.sha : testedSourceSha, "TESTED_SOURCE_SHA"],
      [preview.binding.planDigest, "PLAN_DIGEST"],
      [preview.binding.resultSetDigest, "RESULT_SET_DIGEST"],
      [envelope.validation.requestId, "REQUEST_ID"],
      [result.id, "RESULT_ID"],
      [result.resultDigest, "RESULT_DIGEST"],
      [completed.result.report.checks[0].id, "CHECK_ID"],
      [evidenceId, "EVIDENCE_ID"],
      [preview.publicationId, "PUBLICATION_ID"],
      [preview.semanticSha256, "SEMANTIC_SHA256"],
    ]);
    // Replace the number only in the repository line; other substitutions are generated identities.
    substitutions.delete(String(snapshot.number));
    let template = preview.payload.body.replace(
      `Repository: ${repository}; work item: #${snapshot.number}`,
      `Repository: ${repository}; work item: #{{NEW_WORK_ITEM_NUMBER}}`,
    );
    for (const [value, name] of [...substitutions].sort((a, b) => b[0].length - a[0].length)) {
      assert.equal(typeof value, "string");
      assert(value.length > 0);
      template = template.replaceAll(value, `{{${name}}}`);
    }
    return {
      fixture,
      database,
      query,
      preview,
      template,
      close,
      fixtureDirectory: dirname(fixture.evidenceDirectory),
      syntheticResult: completed.result,
      async publish(token, approvedTemplate) {
        assert.equal(
          template,
          approvedTemplate,
          "The rendered semantic body differs from approval.",
        );
        assert.equal(
          preview.payload.kind,
          kind === "pull_request" ? "pull_request_review" : "issue_comment",
        );
        if (kind === "pull_request") assert.equal(preview.payload.event, "COMMENT");
        const expectedPath = `/repos/${repository}/${kind === "pull_request" ? "pulls" : "issues"}/${snapshot.number}/${kind === "pull_request" ? "reviews" : "comments"}`;
        const expectedBody =
          kind === "pull_request"
            ? { commit_id: snapshot.head.sha, body: preview.payload.body, event: "COMMENT" }
            : { body: preview.payload.body };
        let postCount = 0,
          getCount = 0;
        const client = new GitHubPublicationClient({
          token,
          expectedGitHubUserId: publisherId,
          fetchImplementation: async (url, init) => {
            const parsed = new URL(String(url));
            assert.equal(parsed.origin, "https://api.github.com");
            if (init?.method === "POST") {
              assert.equal(parsed.pathname, expectedPath);
              assert.deepEqual(JSON.parse(String(init.body)), expectedBody);
              assert.equal(++postCount, 1, "A publication must never be resent.");
            } else {
              assert.equal(init?.method, "GET");
              assert(
                parsed.pathname === "/user" ||
                  parsed.pathname === `/repos/${repository}` ||
                  parsed.pathname ===
                    `/repos/${repository}/${kind === "pull_request" ? "pulls" : "issues"}/${snapshot.number}` ||
                  parsed.pathname === expectedPath,
              );
              getCount++;
            }
            const response = await fetch(url, init);
            if (init?.method === "POST" && response.ok) {
              await response.arrayBuffer();
              throw new Error("Synthetic loss of the successful publication acknowledgement.");
            }
            return response;
          },
        });
        await database.request("confirmPublication", { ...query, ...confirmation(preview) });
        const shutdown = new AbortController();
        const messages = [];
        const logger = {
          warn: () => messages.push("publisher-warning"),
          error: () => messages.push("publisher-error"),
        };
        const publisher = startPublicationPublisher(
          fixture.client,
          client,
          logger,
          shutdown.signal,
        );
        const read = () =>
          database.request("getPublication", {
            repositoryId: query.repositoryId,
            actor,
            publicationId: preview.publicationId,
          });
        const waitFor = async (status) => {
          const deadline = Date.now() + 150_000;
          for (;;) {
            const value = await read();
            if (value.delivery.status === status) return value;
            assert(
              Date.now() < deadline,
              `Publication did not reach ${status} within its deadline.`,
            );
            assert(
              !["blocked", "failed", "cancelled"].includes(value.delivery.status),
              "Publication was rejected.",
            );
            await delay(100);
          }
        };
        try {
          const uncertain = await waitFor("unknown");
          assert.equal(postCount, 1);
          await database.request("requestPublicationReconciliation", {
            repositoryId: query.repositoryId,
            actor,
            publicationId: preview.publicationId,
            changeId: `${acceptanceId}-reconcile`,
            expectedVersion: uncertain.delivery.version,
            expectedPayloadSha256: preview.payloadSha256,
          });
          publisher.wake();
          const published = await waitFor("published");
          const secondRead = await client.reconcile(published.intent);
          assert.equal(secondRead.status, "published");
          assert.deepEqual(secondRead.remoteReceipt, published.delivery.remoteReceipt);
          assert.equal(postCount, 1);
          const attempts = await database.request("listPublicationAttempts", {
            repositoryId: query.repositoryId,
            actor,
            publicationId: preview.publicationId,
          });
          return { publication: published, attempts, postCount, getCount, messages };
        } finally {
          shutdown.abort();
          await publisher.stop();
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
