import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EvaluationAdjudicationContextV1 } from "@agentic-review/contracts";
import {
  createQualityCorpus,
  qualityAdjudicationPayload,
  qualityCaseAnnotation,
  qualityCaseDefinitions,
} from "./quality-corpus.js";

test("the corpus has two different regression classes and a fully labeled fixed control", () => {
  const definitions = qualityCaseDefinitions();
  assert.equal(definitions.length, 3);
  assert.equal(new Set(definitions.map((entry) => entry.caseId)).size, 3);
  const positive = definitions.filter((entry) => entry.classification === "regression");
  assert.equal(positive.length, 2);
  assert.equal(new Set(positive.map((entry) => entry.path)).size, 2);
  assert.equal(positive.flatMap((entry) => entry.expectedFindings).length, 2);
  const control = definitions.find((entry) => entry.classification === "fixed_control");
  assert.ok(control);
  assert.equal(control.expectedFindings.length, 0);
  assert.notEqual(control.baseSource, control.headSource);
});

test("owned Git revisions provide measured ground truth and explicit annotation payloads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "synthetic-cli-quality-"));
  const options = {
    directory: join(root, "corpus"),
    gitExecutablePath:
      process.env.QUALITY_CORPUS_GIT ??
      (process.platform === "win32" ? "C:/Program Files/Git/cmd/git.exe" : "/usr/bin/git"),
    nodeExecutablePath: process.execPath,
    repoFullName: "agentic-review-fixture/workflow-0123456789abcdef",
  };
  let passed = false;
  try {
    const corpus = await createQualityCorpus(options);
    assert.equal(corpus.cases.length, 3);
    assert.match(corpus.scope, /not a real PowerToys quality benchmark/u);
    assert.equal(new Set(corpus.cases.map((entry) => entry.bareDirectory)).size, 1);
    assert.equal(new Set(corpus.cases.map((entry) => entry.sourceDirectory)).size, 3);
    assert.deepEqual(
      corpus.cases.map((entry) => entry.pullRequestNumber),
      [1, 2, 3],
    );
    assert.deepEqual(
      corpus.cases.map((entry) => [entry.base.failedCount, entry.head.failedCount]),
      [
        [0, 3],
        [3, 0],
        [0, 3],
      ],
    );
    for (const entry of corpus.cases) {
      assert.match(entry.baseSha, /^[a-f0-9]{40}$/u);
      assert.match(entry.headSha, /^[a-f0-9]{40}$/u);
      assert.notEqual(entry.baseSha, entry.headSha);
      assert.equal(entry.base.revision, entry.baseSha);
      assert.equal(entry.head.revision, entry.headSha);
      assert.equal(entry.head.nodeVersion, process.version);
      const definition = qualityCaseDefinitions().find(
        (candidate) => candidate.caseId === entry.caseId,
      )!;
      assert.equal(
        await readFile(join(entry.sourceDirectory, definition.path), "utf8"),
        definition.headSource,
      );
      for (const path of Object.keys(entry.fileSha256)) {
        const source = await readFile(join(entry.sourceDirectory, path), "utf8");
        assert.doesNotMatch(source, /regression|fixed.control|expectedFindingId|ground.truth/iu);
        for (const expected of definition.expectedFindings)
          assert.ok(!source.includes(expected.expectedFindingId));
      }
      assert.ok(!entry.reviewPrompt.includes("expectedFindingId"));
      assert.ok(!entry.reviewPrompt.includes("healthy control"));
    }
    const receipt = JSON.parse(
      await readFile(join(options.directory, "creation-receipt.json"), "utf8"),
    );
    assert.equal(receipt.failure, null);
    assert.equal(receipt.completedCases, 3);
    assert.ok(
      receipt.commands.every(
        (entry: { arguments: string[] }) =>
          !entry.arguments.includes("commit") && !entry.arguments.includes("push"),
      ),
    );
    for (const command of receipt.commands as { arguments: string[] }[]) {
      if (command.arguments.includes("commit-tree"))
        assert.doesNotMatch(command.arguments.at(-1)!, /regression|fixed|control/iu);
      for (const argument of command.arguments.filter((value) => value.startsWith("refs/heads/")))
        assert.match(argument, /^refs\/heads\/(?:main|case-[1-3])$/u);
    }

    await t.test(
      "complete labels retain both positive findings and the empty negative label",
      () => {
        const annotations = corpus.cases.map((entry, index) =>
          qualityCaseAnnotation(entry, `source-${index + 1}`),
        );
        assert.deepEqual(
          annotations.map((entry) => entry.findings.annotation),
          ["complete", "complete", "complete"],
        );
        assert.deepEqual(
          annotations.map((entry) => entry.findings.expected.length),
          [1, 0, 1],
        );
        assert.ok(annotations.every((entry) => entry.criteria[0]?.expectedOutcome === "passed"));
      },
    );

    await t.test(
      "judgments bind existing occurrence/version metadata and never create a model finding",
      () => {
        const fixture = corpus.cases[0]!;
        // This is a synthetic protocol context for a pure payload-builder test, not CLI output.
        const context: EvaluationAdjudicationContextV1 = {
          schemaVersion: "EvaluationAdjudicationContextV1",
          scope: {
            repositoryId: "repository-1",
            evaluationId: "evaluation-1",
            cellId: "cell-1",
            resultId: "result-1",
          },
          resultDigest: "a".repeat(64),
          caseId: fixture.caseId,
          arm: "baseline",
          modelRequired: true,
          modelState: "completed",
          expectations: qualityCaseAnnotation(fixture, "source-1").findings,
          items: [
            {
              occurrence: {
                key: "b".repeat(64),
                resultId: "result-1",
                resultDigest: "a".repeat(64),
                kind: "pr_finding",
                ordinal: 0,
              },
              version: 2,
              adjudication: null,
            },
          ],
        };
        const judgment = {
          kind: "match" as const,
          expectedFindingId: fixture.expectedFindings[0]!.expectedFindingId,
          reason:
            "Explicit reviewer judgment after comparing the finding with the measured percentage regression.",
        };
        const payload = qualityAdjudicationPayload({
          fixture,
          context,
          occurrenceKey: "b".repeat(64),
          changeId: "judge-1",
          judgment,
        });
        assert.deepEqual(payload, {
          scope: { ...context.scope, occurrenceKey: "b".repeat(64) },
          request: {
            changeId: "judge-1",
            expectedVersion: 2,
            resultDigest: context.resultDigest,
            judgment,
          },
        });
        judgment.reason = "Changed after request creation.";
        assert.notEqual(payload.request.judgment.reason, judgment.reason);
        assert.throws(() =>
          qualityAdjudicationPayload({
            fixture,
            context,
            occurrenceKey: "c".repeat(64),
            changeId: "judge-2",
            judgment,
          }),
        );
        assert.throws(() =>
          qualityAdjudicationPayload({
            fixture,
            context: { ...context, caseId: "another-case" },
            occurrenceKey: "b".repeat(64),
            changeId: "judge-3",
            judgment,
          }),
        );
        assert.throws(() =>
          qualityAdjudicationPayload({
            fixture,
            context,
            occurrenceKey: "b".repeat(64),
            changeId: "judge-4",
            judgment: { ...judgment, expectedFindingId: "unlabeled-defect" },
          }),
        );
      },
    );

    await t.test("an existing corpus directory is never reset or overwritten", async () => {
      const original = await readFile(join(options.directory, "quality-corpus.json"));
      await assert.rejects(createQualityCorpus(options), { code: "EEXIST" });
      assert.deepEqual(await readFile(join(options.directory, "quality-corpus.json")), original);
    });
    passed = true;
  } finally {
    if (passed && process.env.QUALITY_CORPUS_RETAIN !== "1") await rm(root, { recursive: true });
    else process.stdout.write(`Synthetic quality corpus evidence retained at ${root}\n`);
  }
});
