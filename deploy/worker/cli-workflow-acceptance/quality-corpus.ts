import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, parse } from "node:path";
import type {
  EvaluationAdjudicationChangeRequest,
  EvaluationAdjudicationContextV1,
  EvaluationAdjudicationScope,
  EvaluationSuiteDraftCase,
} from "@agentic-review/contracts";

type MeasuredValue = number | boolean;
interface Probe {
  readonly id: string;
  readonly arguments: readonly number[];
  readonly expected: MeasuredValue;
}
export interface QualityExpectedFinding {
  readonly expectedFindingId: string;
  readonly description: string;
  readonly path: string;
  readonly line: number;
  readonly priority: 1 | 2;
}
export interface QualityCaseDefinition {
  readonly caseId: string;
  readonly title: string;
  readonly classification: "regression" | "fixed_control";
  readonly path: string;
  readonly exportName: string;
  readonly contract: string;
  readonly baseSource: string;
  readonly headSource: string;
  readonly probes: readonly Probe[];
  readonly smokeProbeIndices: readonly number[];
  readonly expectedBaseActual: readonly MeasuredValue[];
  readonly expectedHeadActual: readonly MeasuredValue[];
  readonly expectedFindings: readonly QualityExpectedFinding[];
}

const correctDiscount =
  "export function applyDiscount(price, percent) {\n  return price * (1 - percent / 100);\n}\n";
const brokenDiscount =
  "export function applyDiscount(price, percent) {\n  return price * (1 - percent);\n}\n";
const discountContract =
  "applyDiscount(price, percent) returns the discounted price without currency rounding. price is an integer from 0 through 10000. percent is an integer from 0 through 100, inclusive, and denotes percentage points rather than a fraction. For example, applyDiscount(100, 25) must return 75. A zero discount leaves the price unchanged; a full discount returns zero.";
const discountProbes: readonly Probe[] = [
  { id: "zero-discount", arguments: [100, 0], expected: 100 },
  { id: "quarter-discount", arguments: [100, 25], expected: 75 },
  { id: "half-discount", arguments: [200, 50], expected: 100 },
  { id: "full-discount", arguments: [49, 100], expected: 0 },
  { id: "second-zero-discount", arguments: [49, 0], expected: 49 },
];
const definitions: readonly QualityCaseDefinition[] = [
  {
    caseId: "percent-scaling-regression",
    title: "Update percentage discount calculation",
    classification: "regression",
    path: "src/discount.js",
    exportName: "applyDiscount",
    contract: discountContract,
    baseSource: correctDiscount,
    headSource: brokenDiscount,
    probes: discountProbes,
    smokeProbeIndices: [0, 4],
    expectedBaseActual: [100, 75, 100, 0, 49],
    expectedHeadActual: [100, -2400, -9800, -4851, 49],
    expectedFindings: [
      {
        expectedFindingId: "percent-points-must-be-scaled",
        description:
          "src/discount.js:2 removes division by 100 and treats percentage points as a fraction. applyDiscount(100, 25) changes from 75 to -2400; restore percent / 100 before subtraction.",
        path: "src/discount.js",
        line: 2,
        priority: 1,
      },
    ],
  },
  {
    caseId: "percent-scaling-fixed-control",
    title: "Update percentage discount calculation",
    classification: "fixed_control",
    path: "src/discount.js",
    exportName: "applyDiscount",
    contract: discountContract,
    baseSource: brokenDiscount,
    headSource: correctDiscount,
    probes: discountProbes,
    smokeProbeIndices: [0, 4],
    expectedBaseActual: [100, -2400, -9800, -4851, 49],
    expectedHeadActual: [100, 75, 100, 0, 49],
    expectedFindings: [],
  },
  {
    caseId: "capacity-inclusive-boundary-regression",
    title: "Update capacity admission comparison",
    classification: "regression",
    path: "src/capacity.js",
    exportName: "fitsCapacity",
    contract:
      "fitsCapacity(used, requested, capacity) decides whether a reservation fits. All arguments are integers from 0 through 10000. The capacity is inclusive: used + requested <= capacity must be accepted, including an exact fit and a zero reservation at zero capacity. Totals above capacity must be rejected.",
    baseSource:
      "export function fitsCapacity(used, requested, capacity) {\n  return used + requested <= capacity;\n}\n",
    headSource:
      "export function fitsCapacity(used, requested, capacity) {\n  return used + requested < capacity;\n}\n",
    probes: [
      { id: "spare-capacity", arguments: [4, 3, 10], expected: true },
      { id: "exact-fit", arguments: [7, 3, 10], expected: true },
      { id: "zero-capacity", arguments: [0, 0, 0], expected: true },
      { id: "over-capacity", arguments: [8, 3, 10], expected: false },
      { id: "full-reservation", arguments: [0, 10, 10], expected: true },
    ],
    smokeProbeIndices: [0, 3],
    expectedBaseActual: [true, true, true, false, true],
    expectedHeadActual: [true, false, false, false, false],
    expectedFindings: [
      {
        expectedFindingId: "capacity-boundary-is-inclusive",
        description:
          "src/capacity.js:2 changes <= to < and rejects valid exact-fit reservations. fitsCapacity(7, 3, 10) changes from true to false; retain the inclusive comparison, including the zero-capacity case.",
        path: "src/capacity.js",
        line: 2,
        priority: 2,
      },
    ],
  },
];

export function qualityCaseDefinitions(): readonly QualityCaseDefinition[] {
  return structuredClone(definitions);
}

export interface QualityRevisionMeasurement {
  readonly revision: string;
  readonly sourceSha256: string;
  readonly nodeVersion: string;
  readonly probes: readonly (Probe & {
    readonly actual: MeasuredValue;
    readonly passed: boolean;
  })[];
  readonly passedCount: number;
  readonly failedCount: number;
}
export interface QualityCorpusCase {
  readonly caseId: string;
  readonly title: string;
  readonly classification: QualityCaseDefinition["classification"];
  readonly repoFullName: string;
  readonly pullRequestNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly bareDirectory: string;
  readonly sourceDirectory: string;
  readonly fixtureCheckScript: "check.mjs";
  readonly reviewPrompt: string;
  readonly expectedFindings: readonly QualityExpectedFinding[];
  readonly base: QualityRevisionMeasurement;
  readonly head: QualityRevisionMeasurement;
  readonly fileSha256: Readonly<Record<string, string>>;
}
export interface QualityCorpusOptions {
  readonly directory: string;
  readonly gitExecutablePath: string;
  readonly nodeExecutablePath: string;
  readonly repoFullName: string;
}
export interface QualityCorpus {
  readonly schemaVersion: "SyntheticCliQualityCorpusV1";
  readonly scope: string;
  readonly directory: string;
  readonly bareDirectory: string;
  readonly cases: readonly QualityCorpusCase[];
  readonly idealFindingCountsPerArm: {
    readonly expectedFindings: 2;
    readonly truePositives: 2;
    readonly falsePositives: 0;
    readonly falseNegatives: 0;
    readonly healthyControls: 1;
  };
}

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Builds a small labeled synthetic corpus. It does not execute a CLI model or calculate its quality. */
export async function createQualityCorpus(options: QualityCorpusOptions): Promise<QualityCorpus> {
  for (const value of [options.directory, options.gitExecutablePath, options.nodeExecutablePath])
    assert.ok(isAbsolute(value) && !value.includes("\0"));
  assert.notEqual(options.directory, parse(options.directory).root);
  assert.match(options.repoFullName, /^agentic-review-fixture\/workflow-[a-f0-9]{16}$/u);
  await mkdir(options.directory);
  const directory = await realpath(options.directory);
  const bareDirectory = join(directory, "repository.git");
  const temp = join(directory, "temp");
  const hooks = join(directory, "empty-hooks");
  await mkdir(temp);
  await mkdir(hooks);
  const systemRoot = process.env.SYSTEMROOT ?? process.env.SystemRoot;
  if (process.platform === "win32") assert.ok(systemRoot);
  const environment = {
    ...(systemRoot
      ? { SYSTEMROOT: systemRoot, COMSPEC: join(systemRoot, "System32/cmd.exe") }
      : {}),
    PATH: [
      dirname(options.gitExecutablePath),
      dirname(options.nodeExecutablePath),
      ...(systemRoot ? [join(systemRoot, "System32")] : ["/usr/bin", "/bin"]),
    ].join(delimiter),
    HOME: temp,
    USERPROFILE: temp,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_AUTHOR_NAME: "Synthetic Quality Corpus",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic Quality Corpus",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z",
  };
  const commands: {
    executable: string;
    arguments: readonly string[];
    stdout: string;
    stderr: string;
  }[] = [];
  const execute = (executable: string, args: readonly string[], input = "", cwd = directory) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        executable,
        [...args],
        {
          cwd,
          env: environment,
          windowsHide: true,
          shell: false,
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          commands.push({ executable, arguments: [...args], stdout, stderr });
          if (error) reject(error);
          else resolve(stdout.trim());
        },
      );
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    });
  const git = (args: readonly string[], input = "") =>
    execute(
      options.gitExecutablePath,
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "-c",
        `core.hooksPath=${hooks}`,
        "-c",
        "init.templateDir=",
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.eol=lf",
        ...args,
      ],
      input,
    );
  const object = (args: readonly string[], input = "") =>
    git([`--git-dir=${bareDirectory}`, ...args], input);
  const cases: QualityCorpusCase[] = [];
  let failure: unknown;
  try {
    await git([
      "init",
      "--quiet",
      "--bare",
      "--initial-branch=main",
      "--object-format=sha1",
      bareDirectory,
    ]);
    for (const [index, definition] of definitions.entries()) {
      const caseDirectory = join(directory, definition.caseId);
      await mkdir(caseDirectory);
      const smoke = definition.smokeProbeIndices.map((ordinal) => definition.probes[ordinal]!);
      const files = {
        "package.json": `${JSON.stringify({ name: "synthetic-cli-quality-fixture", private: true, type: "module" }, null, 2)}\n`,
        "README.md": `# ${definition.title}\n\n${definition.contract}\n\nRun \`node check.mjs\` for dependency-free smoke checks. These checks cover a subset of the documented contract and are not a complete correctness assessment.\n`,
        "check.mjs": `import assert from 'node:assert/strict';\nimport { ${definition.exportName} as evaluate } from './${definition.path}';\n${smoke.map((probe) => `assert.equal(evaluate(...${JSON.stringify(probe.arguments)}), ${JSON.stringify(probe.expected)});`).join("\n")}\nconsole.log('Documented smoke checks passed.');\n`,
      };
      const createTree = async (source: string) => {
        const sourceBlob = await object(["hash-object", "-w", "--stdin"], source);
        const sourceTree = await object(
          ["mktree"],
          `100644 blob ${sourceBlob}\t${basename(definition.path)}\n`,
        );
        const entries = [`040000 tree ${sourceTree}\tsrc`];
        for (const [name, content] of Object.entries(files)) {
          const blob = await object(["hash-object", "-w", "--stdin"], content);
          entries.push(`100644 blob ${blob}\t${name}`);
        }
        return object(["mktree"], `${entries.join("\n")}\n`);
      };
      const baseTree = await createTree(definition.baseSource);
      const baseSha = await object([
        "commit-tree",
        baseTree,
        "-m",
        "Source before the proposed change",
      ]);
      const headTree = await createTree(definition.headSource);
      const headSha = await object([
        "commit-tree",
        headTree,
        "-p",
        baseSha,
        "-m",
        "Update the documented calculation",
      ]);
      for (const sha of [baseSha, headSha]) assert.match(sha, /^[a-f0-9]{40}$/u);
      assert.notEqual(baseSha, headSha);
      if (index === 0) await object(["update-ref", "refs/heads/main", baseSha]);
      await object(["update-ref", `refs/heads/case-${index + 1}`, headSha]);
      await object(["update-ref", `refs/pull/${index + 1}/head`, headSha]);
      const measure = async (
        revision: string,
        expectedActual: readonly MeasuredValue[],
        label: string,
      ) => {
        const source = await object(["show", `${revision}:${definition.path}`]);
        const moduleUrl = `data:text/javascript;base64,${Buffer.from(`${source}\n`).toString("base64")}`;
        const script = join(caseDirectory, `measure-${label}.mjs`);
        await writeFile(
          script,
          `import { ${definition.exportName} as evaluate } from ${JSON.stringify(moduleUrl)};\nconsole.log(JSON.stringify({ nodeVersion: process.version, actual: ${JSON.stringify(definition.probes.map((probe) => probe.arguments))}.map(args => evaluate(...args)) }));\n`,
          { flag: "wx" },
        );
        const measured = JSON.parse(await execute(options.nodeExecutablePath, [script]));
        assert.match(measured.nodeVersion, /^v\d+\.\d+\.\d+$/u);
        assert.deepEqual(measured.actual, expectedActual, `${definition.caseId} ${label}`);
        const probes = definition.probes.map((probe, ordinal) => ({
          ...structuredClone(probe),
          actual: measured.actual[ordinal] as MeasuredValue,
          passed: measured.actual[ordinal] === probe.expected,
        }));
        return {
          revision,
          sourceSha256: sha256(`${source}\n`),
          nodeVersion: measured.nodeVersion as string,
          probes,
          passedCount: probes.filter((probe) => probe.passed).length,
          failedCount: probes.filter((probe) => !probe.passed).length,
        };
      };
      const base = await measure(baseSha, definition.expectedBaseActual, "base");
      const head = await measure(headSha, definition.expectedHeadActual, "head");
      assert.ok(
        definition.classification === "regression"
          ? base.failedCount === 0 &&
              head.failedCount > 0 &&
              definition.expectedFindings.length === 1
          : base.failedCount > 0 &&
              head.failedCount === 0 &&
              definition.expectedFindings.length === 0,
      );
      const sourceDirectory = join(caseDirectory, "checkout");
      await git(["clone", "--quiet", "--local", "--no-hardlinks", bareDirectory, sourceDirectory]);
      await git(["-C", sourceDirectory, "checkout", "--quiet", "--detach", headSha]);
      await execute(options.nodeExecutablePath, ["check.mjs"], "", sourceDirectory);
      assert.equal(await git(["-C", sourceDirectory, "status", "--porcelain=v1"]), "");
      const fileSha256: Record<string, string> = {};
      for (const path of [...Object.keys(files), definition.path])
        fileSha256[path] = sha256(await readFile(join(sourceDirectory, path)));
      assert.equal(fileSha256[definition.path], head.sourceSha256);
      cases.push({
        caseId: definition.caseId,
        title: definition.title,
        classification: definition.classification,
        repoFullName: options.repoFullName,
        pullRequestNumber: index + 1,
        baseSha,
        headSha,
        bareDirectory,
        sourceDirectory,
        fixtureCheckScript: "check.mjs",
        expectedFindings: structuredClone(definition.expectedFindings),
        base,
        head,
        fileSha256,
        reviewPrompt: [
          "Review this owned synthetic pull request for actionable correctness defects introduced by the change.",
          `The exact base commit is ${baseSha}; the exact head commit is ${headSha}.`,
          "Compare their local Git diff and source with the README contract. You may run node check.mjs. Passing smoke checks alone does not establish correctness.",
          "Keep inspection inside this checkout. Do not modify files, install dependencies, fetch or push, contact GitHub, or create or change any PR or issue.",
          "Do not inspect credentials, authentication, provider settings, or any file outside this checkout.",
          "Return the required PrReviewPlanV2 JSON with requestedRecipeIds set to an empty array. Describe only verification actually performed.",
        ].join("\n"),
      });
    }
    const corpus: QualityCorpus = {
      schemaVersion: "SyntheticCliQualityCorpusV1",
      scope:
        "Three fully labeled, deliberately small synthetic PR cases: two defect classes and one fixed control. This is a quality regression corpus, not a real PowerToys quality benchmark. Oracle expectations and ideal counts are not observed model results.",
      directory,
      bareDirectory,
      cases,
      idealFindingCountsPerArm: {
        expectedFindings: 2,
        truePositives: 2,
        falsePositives: 0,
        falseNegatives: 0,
        healthyControls: 1,
      },
    };
    await writeFile(
      join(directory, "quality-corpus.json"),
      `${JSON.stringify(corpus, null, 2)}\n`,
      { flag: "wx" },
    );
    return corpus;
  } catch (error) {
    failure = error instanceof Error ? { name: error.name, message: error.message } : String(error);
    throw error;
  } finally {
    await writeFile(
      join(directory, "creation-receipt.json"),
      `${JSON.stringify({ commands, completedCases: cases.length, failure: failure ?? null }, null, 2)}\n`,
      { flag: "wx" },
    );
  }
}

/** Source IDs must come from the real isolated Server capture; labels stay outside model inputs. */
export function qualityCaseAnnotation(
  fixture: QualityCorpusCase,
  sourceId: string,
): EvaluationSuiteDraftCase {
  assert.match(sourceId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u);
  return {
    caseId: fixture.caseId,
    title: fixture.title,
    sourceId,
    applicability: { state: "applicable" },
    criteria: [
      {
        criterionId: "fixture-smoke",
        description: "The documented partial smoke check passes.",
        applicability: { state: "applicable" },
        expectedOutcome: "passed",
      },
    ],
    findings: {
      annotation: "complete",
      expected: fixture.expectedFindings.map(({ expectedFindingId, description }) => ({
        expectedFindingId,
        description,
      })),
    },
  };
}

/** Packages an explicit reviewer judgment about an existing occurrence; never invents a finding. */
export function qualityAdjudicationPayload(input: {
  readonly fixture: QualityCorpusCase;
  readonly context: EvaluationAdjudicationContextV1;
  readonly occurrenceKey: string;
  readonly changeId: string;
  readonly judgment: EvaluationAdjudicationChangeRequest["judgment"];
}): { scope: EvaluationAdjudicationScope; request: EvaluationAdjudicationChangeRequest } {
  const { fixture, context, occurrenceKey, changeId, judgment } = input;
  assert.equal(context.schemaVersion, "EvaluationAdjudicationContextV1");
  assert.equal(context.caseId, fixture.caseId);
  assert.equal(context.modelRequired, true);
  assert.equal(context.modelState, "completed");
  assert.deepEqual(
    context.expectations,
    qualityCaseAnnotation(fixture, "source-placeholder").findings,
  );
  const selected = context.items.find((item) => item.occurrence.key === occurrenceKey);
  assert.ok(selected, "Select an occurrence returned by getEvaluationAdjudicationContext.");
  assert.equal(selected.occurrence.resultId, context.scope.resultId);
  assert.equal(selected.occurrence.resultDigest, context.resultDigest);
  assert.ok(Number.isSafeInteger(selected.version) && selected.version >= 0);
  if (judgment.kind === "match")
    assert.ok(
      fixture.expectedFindings.some(
        (finding) => finding.expectedFindingId === judgment.expectedFindingId,
      ),
    );
  if (judgment.kind === "duplicate") {
    assert.notEqual(judgment.primaryOccurrenceKey, occurrenceKey);
    assert.ok(
      context.items.some(
        (item) =>
          item.occurrence.key === judgment.primaryOccurrenceKey &&
          item.adjudication?.kind === "match",
      ),
    );
  }
  assert.match(changeId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u);
  assert.ok(
    judgment.reason.trim().length > 0 &&
      judgment.reason.length <= 2048 &&
      !judgment.reason.includes("\0"),
  );
  return {
    scope: { ...context.scope, occurrenceKey },
    request: {
      changeId,
      expectedVersion: selected.version,
      resultDigest: context.resultDigest,
      judgment: structuredClone(judgment),
    },
  };
}
