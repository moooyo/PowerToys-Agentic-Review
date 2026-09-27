import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonFile } from "./observation-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const resultStates = new Set(["not_run", "blocked", "failed", "passed"]);
const maximumEvidenceBytes = 2_147_483_648;

export function acceptanceTemplate(catalogs, sourceRevision) {
  assert(/^[a-f0-9]{40}$/u.test(sourceRevision), "Use the full target source revision.");
  const scenarios = catalogs.flatMap((catalog) => {
    assert(
      catalog.schemaVersion === 1 && Array.isArray(catalog.scenarios),
      "Unsupported acceptance catalog.",
    );
    return catalog.scenarios;
  });
  assert(
    new Set(scenarios.map((scenario) => scenario.id)).size === scenarios.length,
    "Duplicate scenario IDs.",
  );
  return {
    schemaVersion: "InvestigationOperationsAcceptanceV1",
    sourceRevision,
    createdAt: new Date().toISOString(),
    results: scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      status: "not_run",
      runId: null,
      startedAt: null,
      finishedAt: null,
      evidence: [],
      notes: [],
    })),
  };
}

function contained(root, path) {
  const difference = relative(root, path);
  return (
    difference !== "" &&
    difference !== ".." &&
    !difference.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(difference)
  );
}

async function evidenceDigest(root, evidence) {
  assert(
    typeof evidence.path === "string" && !isAbsolute(evidence.path) && evidence.path.length <= 2048,
    "Evidence paths must be relative to the evidence root.",
  );
  const lexical = resolve(root, evidence.path);
  assert(contained(root, lexical), "Evidence escapes its declared root.");
  const state = await lstat(lexical);
  assert(
    state.isFile() && !state.isSymbolicLink() && state.size <= maximumEvidenceBytes,
    "Evidence must be an ordinary bounded file.",
  );
  const actual = await realpath(lexical);
  assert(contained(root, actual), "Evidence resolves outside its declared root.");
  assert(/^[a-f0-9]{64}$/u.test(evidence.sha256), "Supply the exact evidence SHA-256.");
  const digest = createHash("sha256");
  let length = 0;
  for await (const chunk of createReadStream(actual)) {
    length += chunk.length;
    assert(length <= maximumEvidenceBytes, "Evidence exceeds its byte limit.");
    digest.update(chunk);
  }
  assert.equal(digest.digest("hex"), evidence.sha256, "Evidence digest mismatch.");
  assert.equal(length, state.size, "Evidence changed while being read.");
  return { kind: evidence.kind, path: evidence.path, sha256: evidence.sha256, byteLength: length };
}

/** Evidence integrity is checked here; a recorded human/runner verdict is never a fresh execution. */
export async function summarizeAcceptance(catalogs, input, evidenceRoot) {
  const expected = acceptanceTemplate(catalogs, input.sourceRevision);
  assert(
    input.schemaVersion === expected.schemaVersion && Array.isArray(input.results),
    "Unsupported results packet.",
  );
  const allowed = new Set(expected.results.map((result) => result.scenarioId));
  const observed = new Map();
  for (const result of input.results) {
    assert(
      allowed.has(result.scenarioId) && !observed.has(result.scenarioId),
      "Unknown or duplicate scenario result.",
    );
    assert(resultStates.has(result.status), "Unknown scenario status.");
    observed.set(result.scenarioId, result);
  }
  const root = await realpath(evidenceRoot);
  const scenarios = [];
  for (const definition of catalogs.flatMap((catalog) => catalog.scenarios)) {
    const result = observed.get(definition.id);
    if (result === undefined || result.status === "not_run") {
      scenarios.push({ scenarioId: definition.id, status: "not_run", evidence: [] });
      continue;
    }
    const entry = {
      scenarioId: definition.id,
      declaredStatus: result.status,
      status: result.status,
      evidence: [],
    };
    try {
      assert(
        typeof result.runId === "string" && result.runId.length > 0 && result.runId.length <= 128,
        "A performed scenario needs a bounded run identity.",
      );
      const startedAt = Date.parse(result.startedAt);
      const finishedAt = Date.parse(result.finishedAt);
      assert(
        Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt,
        "A performed scenario needs its observation window.",
      );
      assert(
        Array.isArray(result.evidence) && result.evidence.length <= 128,
        "Evidence must be a bounded array.",
      );
      for (const evidence of result.evidence) {
        assert(
          typeof evidence.kind === "string" &&
            definition.requiredEvidenceKinds.includes(evidence.kind),
          "Evidence kind is not declared by this scenario.",
        );
        entry.evidence.push(await evidenceDigest(root, evidence));
      }
      if (result.status === "passed") {
        for (const kind of definition.requiredEvidenceKinds) {
          assert(
            entry.evidence.some((evidence) => evidence.kind === kind),
            "Required evidence is missing.",
          );
        }
        // A digest establishes unchanged bytes, not the truth or scope of a UI/model observation.
        entry.status = "ready_for_review";
      }
      entry.runId = result.runId;
      entry.startedAt = result.startedAt;
      entry.finishedAt = result.finishedAt;
    } catch {
      entry.status = "invalid_evidence";
      entry.reason =
        "Invalid result metadata, missing required evidence, or an evidence integrity failure.";
    }
    scenarios.push(entry);
  }
  return {
    schemaVersion: "InvestigationOperationsAcceptanceSummaryV1",
    sourceRevision: input.sourceRevision,
    generatedAt: new Date().toISOString(),
    status: scenarios.every((scenario) => scenario.status === "ready_for_review")
      ? "ready_for_review"
      : "incomplete",
    meaning:
      "Recorded outcomes and evidence integrity only. A reviewer must verify source, target, assertions, environment, and authorization scope before accepting deployment.",
    scenarios,
  };
}

async function main() {
  const args = new Map();
  assert((process.argv.length - 2) % 2 === 0, "Arguments must be --name value pairs.");
  for (let index = 2; index < process.argv.length; index += 2) {
    assert(!args.has(process.argv[index]), "Duplicate argument.");
    args.set(process.argv[index], process.argv[index + 1]);
  }
  const mode = args.get("--mode");
  const allowed =
    mode === "prepare"
      ? ["--mode", "--source-revision", "--output"]
      : ["--mode", "--input", "--evidence-root", "--output"];
  assert(
    args.size === allowed.length && allowed.every((key) => args.has(key)),
    "Use prepare with source-revision/output, or summarize with input/evidence-root/output.",
  );
  const catalogs = await Promise.all(
    ["acceptance-catalog.json", "historical-scenarios.json"].map((name) =>
      readJsonFile(resolve(here, name)),
    ),
  );
  let output;
  if (mode === "prepare") output = acceptanceTemplate(catalogs, args.get("--source-revision"));
  else {
    assert.equal(mode, "summarize", "Unsupported mode.");
    output = await summarizeAcceptance(
      catalogs,
      await readJsonFile(resolve(args.get("--input"))),
      resolve(args.get("--evidence-root")),
    );
  }
  await writeFile(resolve(args.get("--output")), `${JSON.stringify(output, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify({ status: output.status ?? "not_run" }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("Acceptance packet preparation or evidence review failed.");
    process.exitCode = 1;
  });
}
