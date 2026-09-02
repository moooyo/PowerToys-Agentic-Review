import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import {
  cleanOutputDirectory,
  verifyReviewedRoleTypeBoxValueImport,
  verifyReviewedRoleTypeBoxValueShim,
} from "./build-worker-bundles.mjs";
import {
  reviewedTypeBoxConstructorPolicyForTest,
  roleBundlePolicyForTest,
  scanRuntimeLoaderSyntax,
  validateReviewedTypeBoxConstructorShapeForTest,
  verifyCanonicalRoleGraph,
  verifyReviewedInputDigest,
} from "./verify-role-bundles.mjs";
import {
  verifyDormantExecutorAttemptReducer,
  verifyDormantSourceExclusionForTest,
  verifyZeroExecutionProductionArchitecture,
} from "./verify-zero-execution-architecture.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const dormantVersionFoundationSha256 = Object.freeze({
  "packages/contracts/src/index.ts":
    "b5ec1e3a50525a2228979cf5b73afb423c804822c94f4dede91117e3d8f7944b",
  "packages/contracts/src/job-envelope.ts":
    "ba50a125b17446d6a8d42b871fb7f324f67f9ad383ec0c5d039d79a3beea69d3",
  "packages/local-protocol/src/framing.ts":
    "a2d1e79c9f3bb1ac564d8225e0f091f691f38b09d84b1187078bd1511ff00d18",
  "packages/local-protocol/src/index.ts":
    "1ba75fe66385d3867731de3f91d2071e38ad4e127ca82ed17717b39a1ac75841",
  "packages/local-protocol/src/messages.ts":
    "5c69fda0dc87a7d348a0877f355cf029842896706352db4172fcca6fe730e3cb",
});
const reviewedRootBarrelExports = Object.freeze({
  "packages/contracts/src/index.ts": Object.freeze([
    "./artifacts.js",
    "./common.js",
    "./dashboard.js",
    "./github.js",
    "./job-envelope.js",
    "./scheduling.js",
    "./states.js",
    "./worker.js",
  ]),
  "packages/local-protocol/src/index.ts": Object.freeze([
    "./artifact-stream.js",
    "./canonical.js",
    "./capability.js",
    "./framing.js",
    "./handshake.js",
    "./messages.js",
    "./replay.js",
  ]),
});

test("clean build removes polluted output before producing role artifacts", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "worker-role-build-"));
  const dist = resolve(root, "dist");
  try {
    await mkdir(dist);
    await writeFile(resolve(dist, "injected-chunk.mjs"), "export default true;", "utf8");
    await cleanOutputDirectory(dist, root);
    await assert.rejects(readFile(resolve(dist, "injected-chunk.mjs"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact role graph accepts reviewed zero-byte barrels and rejects path rebinding", () => {
  const policy = roleBundlePolicyForTest.control;
  const validInputs = Object.fromEntries(policy.allowedInputs.map((input) => [input, 1]));
  const zeroByteBarrel = "packages/local-protocol/src/index.ts";
  validInputs[zeroByteBarrel] = 0;
  validInputs["apps/worker/src/service-host/typebox-value-check.ts"] = 0;
  assert.doesNotThrow(() =>
    verifyCanonicalRoleGraph("control", {
      entryPoint: policy.entryPoint,
      outputs: policy.outputs,
      inputs: validInputs,
    }),
  );

  const reboundInputs = { ...validInputs };
  delete reboundInputs[zeroByteBarrel];
  reboundInputs[`vendor/${zeroByteBarrel}`] = 0;
  assert.throws(() =>
    verifyCanonicalRoleGraph("control", {
      entryPoint: policy.entryPoint,
      outputs: policy.outputs,
      inputs: reboundInputs,
    }),
  );
});

test("exact role graph requires positive bytes from critical implementations", () => {
  const policy = roleBundlePolicyForTest.control;
  const validInputs = Object.fromEntries(policy.allowedInputs.map((input) => [input, 1]));
  for (const input of [
    policy.entryPoint,
    "apps/worker/src/service-host/runtime-bootstrap.ts",
    "apps/worker/src/service-host/runtime-bootstrap-handshake.ts",
    "packages/local-protocol/src/handshake.ts",
    "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/check/check.mjs",
  ]) {
    assert.throws(() =>
      verifyCanonicalRoleGraph("control", {
        entryPoint: policy.entryPoint,
        outputs: policy.outputs,
        inputs: { ...validInputs, [input]: 0 },
      }),
    );
  }
});

test("role policies include the exact shadow-runtime source additions", () => {
  const control = new Set(roleBundlePolicyForTest.control.allowedInputs);
  const executor = new Set(roleBundlePolicyForTest.executor.allowedInputs);
  for (const input of [
    "apps/worker/src/contracts-formats.ts",
    "apps/worker/src/control/host-control-api-common.ts",
    "apps/worker/src/control/host-control-shadow-api.ts",
    "apps/worker/src/control/shadow-supervisor.ts",
    "apps/worker/src/server-client/errors.ts",
    "packages/contracts/src/common.ts",
    "packages/contracts/src/states.ts",
    "packages/contracts/src/worker.ts",
  ]) {
    assert.equal(control.has(input), true, `Control policy is missing ${input}`);
    assert.equal(executor.has(input), false, `Executor policy unexpectedly includes ${input}`);
  }
  assert.equal(executor.has("apps/worker/src/service-host/executor-shadow-runtime.ts"), true);
  assert.equal(control.has("apps/worker/src/service-host/executor-shadow-runtime.ts"), false);
  assert.equal(control.has("apps/worker/src/control/host-control-worker-api.ts"), false);
  assert.equal(executor.has("apps/worker/src/control/host-control-worker-api.ts"), false);
  assert.equal(control.has("apps/worker/src/control/result-artifact-upload-session.ts"), false);
  assert.equal(executor.has("apps/worker/src/control/result-artifact-upload-session.ts"), false);
  for (const input of [
    "apps/worker/src/control/artifact-host-control-v2-api.ts",
    "apps/worker/src/service-host/artifact-host-control-v2-protocol.ts",
    "packages/contracts/src/job-envelope-v2.ts",
    "packages/local-protocol/src/minor-1.ts",
  ]) {
    assert.equal(control.has(input), false, `Control policy unexpectedly includes ${input}`);
    assert.equal(executor.has(input), false, `Executor policy unexpectedly includes ${input}`);
  }
  assert.equal(control.has("apps/worker/src/execution/executor-attempt-reducer.ts"), false);
  assert.equal(executor.has("apps/worker/src/execution/executor-attempt-reducer.ts"), false);
  for (const input of [
    "packages/contracts/src/index.ts",
    "packages/contracts/src/github.ts",
    "packages/contracts/src/scheduling.ts",
    "packages/contracts/src/dashboard.ts",
    "packages/contracts/src/job-envelope.ts",
  ]) {
    assert.equal(control.has(input), false, `Control policy unexpectedly includes ${input}`);
    assert.equal(executor.has(input), false, `Executor policy unexpectedly includes ${input}`);
  }
  for (const input of executor) {
    assert.doesNotMatch(
      input,
      /^(?:apps\/worker\/src\/(?:control|execution|server-client|workspaces?)\/|packages\/(?:codex|contracts)\/)/u,
    );
  }
});

test("dormant version foundations leave the production v0 and v1 contracts byte-exact", () => {
  for (const [path, expected] of Object.entries(dormantVersionFoundationSha256)) {
    const normalized = repositorySource(path).replaceAll("\r\n", "\n");
    assert.equal(createHash("sha256").update(normalized, "utf8").digest("hex"), expected);
  }
  for (const [path, expected] of Object.entries(reviewedRootBarrelExports)) {
    assert.deepEqual(staticExportSources(repositorySource(path), path), expected);
  }
});

test("shadow architecture remains zero execution and role separated", () => {
  const controlMain = repositorySource("apps/worker/src/control-main.ts");
  const executorMain = repositorySource("apps/worker/src/executor-main.ts");
  const controlAdapter = repositorySource("apps/worker/src/control/host-control-shadow-api.ts");
  const controlAdapterCommon = repositorySource(
    "apps/worker/src/control/host-control-api-common.ts",
  );
  const controlRuntime = repositorySource("apps/worker/src/control/shadow-supervisor.ts");
  const executorRuntime = repositorySource(
    "apps/worker/src/service-host/executor-shadow-runtime.ts",
  );
  const runtimeBootstrap = repositorySource("apps/worker/src/service-host/runtime-bootstrap.ts");
  const nativeBootstrap = repositorySource(
    "native/service-host/internal/localrpc/runtime_bootstrap.go",
  );

  assert.match(controlMain, /installRuntime:\s*installControlZeroSlotShadowSupervisor/u);
  assert.match(controlMain, /validateRuntimeSession:\s*isControlHostControlClient/u);
  assert.match(executorMain, /installRuntime:\s*installExecutorShadowRuntime/u);
  assert.match(executorMain, /validateRuntimeSession:\s*isExecutorHostControlSession/u);
  assert.match(controlRuntime, /activation\.activated\.then\(/u);
  assert.match(executorRuntime, /activation\.activated\.then\(/u);
  assert.match(controlRuntime, /import \{ HostControlShadowApi \}/u);
  assert.match(controlRuntime, /from "\.\/host-control-shadow-api\.js"/u);
  assert.doesNotMatch(controlRuntime, /\bHostControlWorkerApi\b/u);
  assert.doesNotMatch(controlAdapterCommon, /@agentic-review\/contracts/u);

  const controlRoleConfig = sourceSection(
    runtimeBootstrap,
    "export const ControlFoundationRoleConfigV2Schema",
    "export const ExecutorFoundationRoleConfigV2Schema",
  );
  const executorRoleConfig = sourceSection(
    runtimeBootstrap,
    "export const ExecutorFoundationRoleConfigV2Schema",
    "export type ControlFoundationRoleConfigV2",
  );
  for (const section of [controlRoleConfig, executorRoleConfig]) {
    assert.match(section, /executionEnabled:\s*Type\.Literal\(false\)/u);
    assert.doesNotMatch(section, /executionEnabled:\s*Type\.Literal\(true\)/u);
  }
  assert.equal((nativeBootstrap.match(/"executionEnabled":\s+false/gu) ?? []).length, 2);
  assert.doesNotMatch(nativeBootstrap, /"executionEnabled":\s+true/u);

  const ready = sourceSection(
    executorRuntime,
    "const readyCandidate: ReadyMessage = {",
    "const ready = validateReadyAfterHandshakeProofV1",
  );
  assert.match(ready, /ready:\s*false/u);
  assert.match(ready, /availableSlots:\s*0/u);
  assert.match(ready, /reasonCode:\s*"EXECUTION_DISABLED"/u);
  assert.doesNotMatch(ready, /ready:\s*true/u);
  assert.equal((executorRuntime.match(/messageType:\s*LocalMessageType\.Ready/gu) ?? []).length, 1);

  assert.doesNotMatch(controlRuntime, /\b(?:claim|claimLease|completeRun|failRun|leaseToken)\b/iu);
  assert.doesNotMatch(controlAdapter, /\b(?:claim|claimLease|completeRun|failRun|leaseToken)\b/iu);
  assert.doesNotMatch(executorRuntime, /\b(?:server|mTLS|lease|workspace|process|Codex|Git)\b/iu);
  assert.doesNotMatch(
    executorRuntime,
    /from\s+["'][^"']*(?:server-client|execution|workspace|process-host|codex|git)[^"']*["']/iu,
  );
});

test("production role entrypoints and reachable imports remain zero execution", () => {
  assert.doesNotThrow(() => verifyZeroExecutionProductionArchitecture());

  const controlMainPath = "apps/worker/src/control-main.ts";
  const executorMainPath = "apps/worker/src/executor-main.ts";
  const roleEntrypointPath = "apps/worker/src/service-host/role-entrypoint.ts";
  const contractsWorkerPath = "packages/contracts/src/worker.ts";
  const contractsIndexPath = "packages/contracts/src/index.ts";
  const localProtocolIndexPath = "packages/local-protocol/src/index.ts";
  const dormantReducerPath = "apps/worker/src/execution/executor-attempt-reducer.ts";
  const dormantUploadSessionPath = "apps/worker/src/control/result-artifact-upload-session.ts";
  const dormantArtifactV2ApiPath = "apps/worker/src/control/artifact-host-control-v2-api.ts";
  const dormantArtifactV2ProtocolPath =
    "apps/worker/src/service-host/artifact-host-control-v2-protocol.ts";
  const dormantArwxMinorOnePath = "packages/local-protocol/src/minor-1.ts";
  const dormantJobEnvelopeV2Path = "packages/contracts/src/job-envelope-v2.ts";
  const controlMain = repositorySource(controlMainPath);
  const executorMain = repositorySource(executorMainPath);
  const roleEntrypoint = repositorySource(roleEntrypointPath);
  const contractsWorker = repositorySource(contractsWorkerPath);
  const contractsIndex = repositorySource(contractsIndexPath);
  const localProtocolIndex = repositorySource(localProtocolIndexPath);
  const dormantReducer = repositorySource(dormantReducerPath);
  const dormantUploadSession = repositorySource(dormantUploadSessionPath);
  const dormantArtifactV2Api = repositorySource(dormantArtifactV2ApiPath);
  const dormantArtifactV2Protocol = repositorySource(dormantArtifactV2ProtocolPath);
  const dormantArwxMinorOne = repositorySource(dormantArwxMinorOnePath);
  const dormantJobEnvelopeV2 = repositorySource(dormantJobEnvelopeV2Path);
  assert.match(dormantUploadSession, /export class ResultArtifactUploadSession/u);
  for (const source of [
    controlMain,
    executorMain,
    roleEntrypoint,
    contractsIndex,
    localProtocolIndex,
  ]) {
    assert.doesNotMatch(
      source,
      /result-artifact-upload-session|artifact-host-control-v2|job-envelope-v2|minor-1/u,
    );
  }
  assert.match(dormantArtifactV2Api, /export class ArtifactHostControlV2Api/u);
  assert.match(dormantArtifactV2Protocol, /export function encodeArtifactHostControlV2Call/u);
  assert.match(dormantArwxMinorOne, /export const LOCAL_PROTOCOL_MINOR_1_VERSION = 1/u);
  assert.match(dormantJobEnvelopeV2, /export const JobExecutionEnvelopeV2Schema/u);
  const legacyWorkerServicePath = "apps/worker/src/worker-service.ts";
  const legacyWorkerService = repositorySource(legacyWorkerServicePath);
  assert.throws(
    () =>
      verifyZeroExecutionProductionArchitecture({
        [legacyWorkerServicePath]: `${legacyWorkerService}\nimport "./control/result-artifact-upload-session.js";\n`,
      }),
    /Production import graph reaches dormant source/u,
  );
  for (const path of [dormantArtifactV2ApiPath, dormantArtifactV2ProtocolPath]) {
    assert.throws(
      () =>
        verifyZeroExecutionProductionArchitecture({
          [legacyWorkerServicePath]: `${legacyWorkerService}\nimport "./${path.slice("apps/worker/src/".length).replace(/\.ts$/u, ".js")}";\n`,
        }),
      /Production import graph reaches dormant source/u,
    );
  }
  for (const [path, specifier] of [
    [dormantArwxMinorOnePath, "../../../packages/local-protocol/src/minor-1.js"],
    [dormantJobEnvelopeV2Path, "../../../packages/contracts/src/job-envelope-v2.js"],
    [dormantArwxMinorOnePath, "@agentic-review/local-protocol/minor-1"],
    [dormantJobEnvelopeV2Path, "@agentic-review/contracts/job-envelope-v2"],
  ]) {
    assert.throws(
      () =>
        verifyZeroExecutionProductionArchitecture({
          [legacyWorkerServicePath]: `${legacyWorkerService}\nimport "${specifier}";\n`,
        }),
      new RegExp(
        `Production import graph reaches dormant source: ${path.replaceAll("/", "\\/")}`,
        "u",
      ),
    );
  }
  assert.throws(
    () =>
      verifyZeroExecutionProductionArchitecture({
        [localProtocolIndexPath]: `${localProtocolIndex}\nexport * from "./minor-1.js";\n`,
      }),
    /packages\/local-protocol\/src\/index\.ts differs from its reviewed dormant-foundation source/u,
  );
  assert.throws(
    () =>
      verifyZeroExecutionProductionArchitecture({
        [contractsWorkerPath]: `${contractsWorker}\nexport * from "./job-envelope-v2.js";\n`,
      }),
    /Production import graph reaches dormant source/u,
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [legacyWorkerServicePath]: `${legacyWorkerService}\nconst load = require; load("./control/result-artifact-upload-session.js");\n`,
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [controlMainPath]: replaceRequired(
        controlMain,
        '"./control/shadow-supervisor.js"',
        '"./execution/job-executor.js"',
      ),
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [controlMainPath]: `${controlMain}\nprocess.exitCode = 0;\n`,
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [executorMainPath]: replaceRequired(
        executorMain,
        "connect: async (options, signal) => {",
        "connect: async (options, signal) => { return undefined;",
      ),
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [controlMainPath]: replaceRequired(
        controlMain,
        'if (options.role !== "control") throw new Error("Control connector received another role.");',
        'if (options.role !== "control") throw new Error("Control connector received another role."); else return await connectHostControl(options, signal);',
      ),
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [executorMainPath]: replaceRequired(
        executorMain,
        "return await connectExecutorHostControl(options, signal);",
        "return await connectExecutorHostControl(options, undefined);",
      ),
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [controlMainPath]: replaceRequired(
        controlMain,
        "return await connectHostControl(options, signal);",
        "await connectHostControl(options, signal);\n    return await connectHostControl(options, signal);",
      ),
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [executorMainPath]: replaceRequired(
        executorMain,
        "installRuntime: installExecutorShadowRuntime",
        "installRuntime: installExecutionRuntime",
      ),
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [executorMainPath]: replaceRequired(
        executorMain,
        '"./service-host/executor-shadow-runtime.js"',
        '"./execution/executor-attempt-reducer.js"',
      ),
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [roleEntrypointPath]: `${roleEntrypoint}\nimport "../execution/job-executor.js";\n`,
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [roleEntrypointPath]: `${roleEntrypoint}\nimport "../execution/executor-attempt-reducer.js";\n`,
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [roleEntrypointPath]: `${roleEntrypoint}\nimport "@agentic-review/worker/execution";\n`,
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [roleEntrypointPath]: `${roleEntrypoint}\nimport Forbidden = require("../execution/job-executor.js");\n`,
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [roleEntrypointPath]: `${roleEntrypoint}\nconst load = require; load("../execution/executor-attempt-reducer.js");\n`,
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [roleEntrypointPath]: `${roleEntrypoint}\nconst load = process.getBuiltinModule("node:module").createRequire(import.meta.url); load("../execution/executor-attempt-reducer.js");\n`,
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [roleEntrypointPath]: `${roleEntrypoint}\nconst runtimeProcess = Reflect.get(global, "process"); const load = runtimeProcess["get" + "BuiltinModule"]("node:module").createRequire(import.meta.url); load("../execution/executor-attempt-reducer.js");\n`,
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [contractsWorkerPath]: `${contractsWorker}\nexport * from "../../../apps/worker/src/execution/job-executor.js";\n`,
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [localProtocolIndexPath]: `${localProtocolIndex}\nexport * from "../../../apps/worker/src/execution/executor-attempt-reducer.js";\n`,
    }),
  );
  assert.throws(
    () =>
      verifyZeroExecutionProductionArchitecture({
        [dormantReducerPath]: `${dormantReducer}\nconst scopeDrift = true;\n`,
      }),
    /review the complete file and update its pinned SHA-256/u,
  );
  assert.doesNotThrow(() =>
    verifyZeroExecutionProductionArchitecture({
      "apps/worker/src/control/host-control-worker-api.ts": "this unconnected source is not parsed",
    }),
  );
});

test("every production entrypoint rejects dormant v2 and minor-one imports through every route", () => {
  const targets = [
    {
      entrypoint: "apps/worker/src/main.ts",
      injectionPath: "apps/worker/src/worker-service.ts",
      rootPrefix: "../../../",
    },
    {
      entrypoint: "apps/worker/src/control-main.ts",
      injectionPath: "apps/worker/src/control/shadow-supervisor.ts",
      rootPrefix: "../../../../",
    },
    {
      entrypoint: "apps/worker/src/executor-main.ts",
      injectionPath: "apps/worker/src/service-host/executor-shadow-runtime.ts",
      rootPrefix: "../../../../",
    },
  ];
  const dormantModules = [
    {
      path: "packages/local-protocol/src/minor-1.ts",
      bare: "@agentic-review/local-protocol/minor-1",
      barrelPath: "packages/local-protocol/src/index.ts",
      barrelExport: "./minor-1.js",
    },
    {
      path: "packages/contracts/src/job-envelope-v2.ts",
      bare: "@agentic-review/contracts/job-envelope-v2",
      barrelPath: "packages/contracts/src/index.ts",
      barrelExport: "./job-envelope-v2.js",
    },
  ];

  for (const target of targets) {
    const injectionSource = repositorySource(target.injectionPath);
    for (const dormant of dormantModules) {
      const direct = `${target.rootPrefix}${dormant.path.replace(/\.ts$/u, ".js")}`;
      assert.throws(
        () =>
          verifyDormantSourceExclusionForTest(target.entrypoint, {
            [target.injectionPath]: `${injectionSource}\nimport "${direct}";\n`,
          }),
        /Production import graph reaches dormant source/u,
      );
      assert.throws(
        () =>
          verifyDormantSourceExclusionForTest(target.entrypoint, {
            [target.injectionPath]: `${injectionSource}\nimport "${dormant.bare}";\n`,
          }),
        /Production import graph reaches dormant source/u,
      );
      assert.throws(() =>
        verifyDormantSourceExclusionForTest(target.entrypoint, {
          [target.injectionPath]: `${injectionSource}\nimport Dormant = require("${direct}");\n`,
        }),
      );

      const barrelSpecifier = `${target.rootPrefix}${dormant.barrelPath.replace(/\.ts$/u, ".js")}`;
      assert.throws(
        () =>
          verifyDormantSourceExclusionForTest(target.entrypoint, {
            [target.injectionPath]: `${injectionSource}\nimport "${barrelSpecifier}";\n`,
            [dormant.barrelPath]: `${repositorySource(dormant.barrelPath)}\nexport * from "${dormant.barrelExport}";\n`,
          }),
        /Production import graph reaches dormant source/u,
      );
    }
  }
});

test("dormant Executor attempt reducer remains import-free and synchronous", () => {
  const reducerPath = "apps/worker/src/execution/executor-attempt-reducer.ts";
  const source = repositorySource(reducerPath);
  assert.doesNotThrow(() => verifyDormantExecutorAttemptReducer(source));

  for (const mutation of [
    `${source}\nimport "node:fs";\n`,
    `${source}\nvoid import("node:fs");\n`,
    `${source}\nconst observedAt = Date.now();\n`,
    `${source}\nconst pending = Promise.resolve();\n`,
    `${source}\nexport let mutableState = 0;\n`,
    `${source}\nexport const deferred = { run() {} };\n`,
    `${source}\nconst mutableState = { count: 0 }; function advance() { mutableState.count += 1; }\n`,
    `${source}\nexport enum HiddenState { Active }\n`,
    `${source}\nexport class HiddenState { static state = {}; static { sideEffect(); } }\n`,
    `${source}\nsideEffect();\n`,
    replaceRequired(
      source,
      "  const identity = snapshotIdentity(identityValue);",
      "  const deferredEffect = () => undefined;\n  deferredEffect();\n  const identity = snapshotIdentity(identityValue);",
    ),
    replaceRequired(
      source,
      "export class ExecutorAttemptReducerError extends Error {",
      "export class ExecutorAttemptReducerError extends Error { static state = {};",
    ),
    `${source}\nasync function runLater() {}\n`,
    `${source}\ntype DeferredEffect = () => void;\n`,
    `${source}\nconst loader = new Function("return process");\n`,
    `${source}\nconst builtin = global["process"]["getBuiltinModule"]("fs");\n`,
    `${source}\nconst loader = ({}).constructor.constructor("return process");\n`,
    `${source}\nconst runtimeProcess = Reflect.get(global, "process"); const load = runtimeProcess["get" + "BuiltinModule"]("node:module").createRequire(import.meta.url);\n`,
  ]) {
    assert.throws(() => verifyDormantExecutorAttemptReducer(mutation));
  }
});

test("reviewed production and dormant source digests fence equivalent syntax drift", () => {
  const executorPath = "apps/worker/src/service-host/executor-shadow-runtime.ts";
  const controlPath = "apps/worker/src/control/shadow-supervisor.ts";
  const dormantReducerPath = "apps/worker/src/execution/executor-attempt-reducer.ts";
  const executorSource = repositorySource(executorPath);
  const controlSource = repositorySource(controlPath);
  const dormantReducerSource = repositorySource(dormantReducerPath);
  const crlf = (source) => source.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
  assert.doesNotThrow(() =>
    verifyZeroExecutionProductionArchitecture({
      [executorPath]: crlf(executorSource),
      [controlPath]: crlf(controlSource),
      [dormantReducerPath]: crlf(dormantReducerSource),
    }),
  );

  for (const mutation of [`\uFEFF${executorSource}`, `${executorSource}\r`]) {
    assert.throws(() => verifyZeroExecutionProductionArchitecture({ [executorPath]: mutation }));
  }
  assert.throws(
    () =>
      verifyZeroExecutionProductionArchitecture({
        [controlPath]: `${controlSource}\nconst reviewedScopeDrift = true;\n`,
      }),
    /review the complete file and update its pinned SHA-256/u,
  );

  let controlBypass = replaceRequired(
    controlSource,
    "if (message.messageType === LocalMessageType.HelloAck) {",
    "if (message.messageType === LocalMessageType.HelloAck || message.messageType === 3) {",
  );
  controlBypass = replaceRequired(
    controlBypass,
    "        await this.#acceptHelloAck(message.payload as unknown as HelloAckMessage);",
    `        if (message.messageType === 3) {
          const bypassReady = message.payload as unknown as ReadyMessage;
          this.#readyMessage = bypassReady;
          this.#phase = "ready";
          this.#ready.resolve(bypassReady);
          return;
        }
        await this.#acceptHelloAck(message.payload as unknown as HelloAckMessage);`,
  );
  assert.throws(() => verifyZeroExecutionProductionArchitecture({ [controlPath]: controlBypass }));

  let executorBypass = replaceRequired(
    executorSource,
    "  #settled = false;",
    "  #settled = false;\n  readonly #alternateSend: (message: unknown) => Promise<void>;",
  );
  executorBypass = replaceRequired(
    executorBypass,
    "    this.#arwx = activation.arwx;",
    "    this.#arwx = activation.arwx;\n    this.#alternateSend = activation.arwx.send.bind(activation.arwx);",
  );
  executorBypass = replaceRequired(
    executorBypass,
    '    this.#phase = "ready_disabled";',
    `    await this.#alternateSend({
      messageType: 3,
      correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
      payload: ready,
    });
    this.#phase = "ready_disabled";`,
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({ [executorPath]: executorBypass }),
  );
});

test("disabled Ready remains proof-bound and cannot advertise capacity", () => {
  const executorPath = "apps/worker/src/service-host/executor-shadow-runtime.ts";
  const controlPath = "apps/worker/src/control/shadow-supervisor.ts";
  const source = repositorySource(executorPath);
  const controlSource = repositorySource(controlPath);
  for (const [before, after] of [
    ["ready: false", "ready: true"],
    ["availableSlots: 0", "availableSlots: 1"],
    ['reasonCode: "EXECUTION_DISABLED"', 'reasonCode: "READY"'],
    [
      "validateReadyAfterHandshakeProofV1(readyCandidate, verified)",
      "validateReadyAfterHandshakeProofV1(readyCandidate, proof)",
    ],
    ["verified = verifyControlProofMessageV1(", "verified = validateLocalMessagePayload("],
    ["messageType: LocalMessageType.Ready,", 'messageType: LocalMessageType["Ready"],'],
    [
      "const ready = validateReadyAfterHandshakeProofV1(readyCandidate, verified);",
      "let ready = validateReadyAfterHandshakeProofV1(readyCandidate, verified);\n    ready = readyCandidate;",
    ],
    [
      "const readyCandidate: ReadyMessage = {",
      "return;\n    const readyCandidate: ReadyMessage = {",
    ],
    [
      "await this.#arwx.send({\n      messageType: LocalMessageType.Ready,",
      "if (false) {\n      await this.#arwx.send({\n      messageType: LocalMessageType.Ready,",
    ],
  ]) {
    let mutated = replaceRequired(source, before, after);
    if (after.startsWith("if (false)")) {
      mutated = replaceRequired(
        mutated,
        "      payload: ready,\n    });",
        "      payload: ready,\n    });\n    }",
      );
    }
    assert.throws(() => verifyZeroExecutionProductionArchitecture({ [executorPath]: mutated }));
  }

  for (const [imported, alias, fake] of [
    [
      "verifyControlProofMessageV1",
      "importedVerifyControlProofMessageV1",
      "const verifyControlProofMessageV1 = (proof: unknown): never => proof as never;",
    ],
    [
      "validateReadyAfterHandshakeProofV1",
      "importedValidateReadyAfterHandshakeProofV1",
      "const validateReadyAfterHandshakeProofV1 = (ready: unknown): never => ready as never;",
    ],
  ]) {
    let fakeBinding = replaceRequired(source, `  ${imported},`, `  ${imported} as ${alias},`);
    fakeBinding = replaceRequired(
      fakeBinding,
      "const nonceBytes = 32;",
      `${fake}\nconst nonceBytes = 32;`,
    );
    assert.throws(() => verifyZeroExecutionProductionArchitecture({ [executorPath]: fakeBinding }));
  }
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [executorPath]: replaceRequired(
        source,
        "return await this.#handleControlProof(message);",
        "return;",
      ),
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [executorPath]: `${source}\nconst extraReadyPath = { messageType: LocalMessageType.Ready };\n`,
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [executorPath]: replaceRequired(
        source,
        "const nonceBytes = 32;",
        "const AlternateLocalMessageType = LocalMessageType;\nconst nonceBytes = 32;",
      ),
    }),
  );
  assert.throws(() =>
    verifyZeroExecutionProductionArchitecture({
      [executorPath]: replaceRequired(
        source,
        "const drain = normalizePayload<DrainMessage>(message);",
        `const drain = normalizePayload<DrainMessage>(message);
    await this.#arwx.send({
      messageType: 3 as never,
      correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
      payload: drain,
    });`,
      ),
    }),
  );

  const controlMutations = [
    replaceRequired(controlSource, "ready.ready !== false", "ready.ready === false"),
    replaceRequired(
      controlSource,
      "  const proof = context.proof;\n  if (",
      "  const proof = context.proof;\n  return Object.freeze({ ...ready });\n  if (",
    ),
    replaceRequired(
      controlSource,
      "  const proof = context.proof;",
      "  let proof = context.proof;",
    ),
    replaceRequired(
      controlSource,
      "const ready = validateControlReady(readyValue, signedHandshake);",
      "const ready = Object.freeze({ ...readyValue });",
    ),
    replaceRequired(
      controlSource,
      "this.#acceptReady(message.payload as unknown as ReadyMessage);",
      "this.#readyMessage = message.payload as unknown as ReadyMessage;",
    ),
    replaceRequired(
      controlSource,
      "message.messageType === LocalMessageType.Ready",
      'message.messageType === LocalMessageType["Ready"]',
    ),
    replaceRequired(
      controlSource,
      'const executionDisabledReason = "EXECUTION_DISABLED" as const;',
      'const AlternateLocalMessageType = LocalMessageType;\nconst executionDisabledReason = "EXECUTION_DISABLED" as const;',
    ),
    replaceRequired(
      controlSource,
      "      if (message.messageType === LocalMessageType.Ready) {",
      `      if (message.messageType === 3) {
        this.#readyMessage = message.payload as unknown as ReadyMessage;
        return;
      }
      if (message.messageType === LocalMessageType.Ready) {`,
    ),
    `${controlSource}\nvalidateControlReady = ((ready: Readonly<ReadyMessage>) => ready) as typeof validateControlReady;\n`,
    `${controlSource}\nconst extraReadyReceivePath = { messageType: LocalMessageType.Ready };\n`,
  ];
  let fakeControlBinding = replaceRequired(
    controlSource,
    "  LocalMessageType,",
    "  LocalMessageType as ImportedLocalMessageType,",
  );
  fakeControlBinding = replaceRequired(
    fakeControlBinding,
    'const executionDisabledReason = "EXECUTION_DISABLED" as const;',
    'const LocalMessageType = { Ready: "Ready" } as const;\nconst executionDisabledReason = "EXECUTION_DISABLED" as const;',
  );
  controlMutations.push(fakeControlBinding);
  let deadCodeControl = replaceRequired(
    controlSource,
    "  if (\n    ready.protocolMajor",
    "  if (\n    false && (\n      ready.protocolMajor",
  );
  deadCodeControl = replaceRequired(
    deadCodeControl,
    "    ready.reasonCode !== executionDisabledReason\n  ) {",
    "      ready.reasonCode !== executionDisabledReason\n    )\n  ) {",
  );
  controlMutations.push(deadCodeControl);
  for (const mutation of controlMutations) {
    assert.throws(() => verifyZeroExecutionProductionArchitecture({ [controlPath]: mutation }));
  }
});

test("both role policies require the reviewed bootstrap handshake closure", () => {
  const sharedBootstrapInputs = [
    "apps/worker/src/service-host/arwx-shutdown.ts",
    "apps/worker/src/service-host/opaque-json.ts",
    "apps/worker/src/service-host/runtime-bootstrap.ts",
    "apps/worker/src/service-host/runtime-bootstrap-handshake.ts",
    "packages/local-protocol/src/handshake.ts",
  ];
  for (const role of ["control", "executor"]) {
    const required = new Set(roleBundlePolicyForTest[role].requiredPositiveInputs);
    for (const input of sharedBootstrapInputs) assert.equal(required.has(input), true);
  }
  assert.equal(
    new Set(roleBundlePolicyForTest.executor.requiredWorkerInputs).has(
      "apps/worker/src/service-host/host-control-client.ts",
    ),
    false,
  );
  assert.equal(
    new Set(roleBundlePolicyForTest.executor.requiredWorkerInputs).has(
      "apps/worker/src/service-host/host-control-protocol.ts",
    ),
    true,
  );
});

test("role graph rejects extra output chunks", () => {
  const policy = roleBundlePolicyForTest.executor;
  assert.throws(() =>
    verifyCanonicalRoleGraph("executor", {
      entryPoint: policy.entryPoint,
      outputs: [...policy.outputs, "dist/chunk-injected.mjs"],
      inputs: Object.fromEntries(policy.allowedInputs.map((input) => [input, 1])),
    }),
  );
});

test("reviewed role input digest rejects modified source bytes", () => {
  for (const input of [
    roleBundlePolicyForTest.control.entryPoint,
    "apps/worker/src/service-host/typebox-value-check.ts",
    "packages/local-protocol/src/index.ts",
  ]) {
    assert.throws(
      () => verifyReviewedInputDigest(input, Buffer.from("export const injected = true;", "utf8")),
      /content differs from review/u,
    );
  }
});

test("role TypeBox Value redirect accepts only exact importer and shim syntax", () => {
  assert.doesNotThrow(() =>
    verifyReviewedRoleTypeBoxValueImport('import { Value } from "@sinclair/typebox/value";'),
  );
  assert.doesNotThrow(() =>
    verifyReviewedRoleTypeBoxValueImport(
      repositorySource("apps/worker/src/control/host-control-api-common.ts"),
    ),
  );
  const target =
    "../../../../node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/check/check.mjs";
  assert.equal(verifyReviewedRoleTypeBoxValueShim(`export * as Value from "${target}";`), target);

  for (const source of [
    'import Value from "@sinclair/typebox/value";',
    'import * as Value from "@sinclair/typebox/value";',
    'import { Value, Check } from "@sinclair/typebox/value";',
    'import { Value as RuntimeValue } from "@sinclair/typebox/value";',
    'import { Value } from "@sinclair/typebox/value/check";',
  ]) {
    assert.throws(() => verifyReviewedRoleTypeBoxValueImport(source));
  }
  for (const source of [
    `export { Check as Value } from "${target}";`,
    `export * from "${target}";`,
    `export * as RuntimeValue from "${target}";`,
    `export * as Value from "${target}"; export const extra = true;`,
  ]) {
    assert.throws(() => verifyReviewedRoleTypeBoxValueShim(source));
  }
});

test("runtime loader syntax is rejected while static imports remain allowed", () => {
  scanRuntimeLoaderSyntax('import { createHash } from "node:crypto";', "static.mjs");
  scanRuntimeLoaderSyntax("const T = { Function() {} }; T.Function([], {});", "schema.mjs");
  scanRuntimeLoaderSyntax('export function Function() { return "schema"; }', "schema.mjs");
  scanRuntimeLoaderSyntax(
    "function safe() { const Function = () => undefined; return Function(); }",
    "local-binding.mjs",
  );
  scanRuntimeLoaderSyntax('const record = { constructor: "metadata" };', "data.mjs");
  scanRuntimeLoaderSyntax('const record = { binding: "metadata", _load: "text" };', "data.mjs");
  for (const source of [
    'await import("node:fs")',
    'require("node:fs")',
    "createRequire(import.meta.url)",
    'process.getBuiltinModule("fs")',
    'eval("1")',
    'new Function("return 1")',
    "const Loader = Function;",
    "const Loader = globalThis.Function;",
    'const globalAlias = globalThis; const Loader = globalAlias.Function; Loader("return process")',
    'const { getBuiltinModule: load } = process; load("node:fs")',
    'const run = eval; run("1")',
    'Reflect.get(process, "getBuiltinModule")("node:fs")',
    "const Loader = (() => {}).constructor;",
    "const Loader = value?.constructor;",
    'const Loader = value["constructor"];',
    "const Loader = value[`constructor`];",
    '({}).constructor.constructor("return process")()',
    '({})["constructor"]["constructor"]("return process")()',
    `({})["con" + "structor"][\`con\${"structor"}\`]("return process")()`,
    "const { constructor: Loader } = value;",
    'const { ["constructor"]: Loader } = value;',
    "const { [`constructor`]: Loader } = value;",
    'function safe() { const Function = () => undefined; } const load = Function("return process")',
    'const load = Function("return process"); function safe() { const Function = () => undefined; }',
    'process.binding("fs")',
    'process["binding"]("fs")',
    `process[\`bind\${\`ing\`}\`]("fs")`,
    'const processAlias = process; processAlias["bind" + "ing"]("fs")',
    'const processAlias = process; const key = "binding"; processAlias[key]("fs")',
    'const first = process; const second = first; second[getLoaderName()]("fs")',
    'const { binding: load } = process; load("fs")',
    'process._linkedBinding("fs")',
    'process.dlopen({}, "native.node")',
    'process.mainModule.require("fs")',
    'Module._load("fs")',
    'module["_load"]("fs")',
    `const ModuleAlias = Module; ModuleAlias[\`_\${"load"}\`]("fs")`,
    'const { ["_" + "load"]: load } = Module; load("fs")',
    'const { Function: compile } = globalThis; compile("return process")',
    'const { ["Fun" + "ction"]: compile } = globalThis; compile("return process")',
    "const globalAlias = globalThis; const { [getName()]: compile } = globalAlias;",
    'let compile; ({ Function: compile } = globalThis); compile("return process")',
    'let compile; ({ ["Fun" + "ction"]: compile } = globalThis);',
    'function load({ Function: compile } = globalThis) { return compile("return process"); }',
    'process["get" + "BuiltinModule"]("node:fs")',
    'import vm from "node:vm"',
  ]) {
    assert.throws(() => scanRuntimeLoaderSyntax(source, "injected.mjs"));
  }
});

test("TypeBox constructor exception is path, digest, count, and shape bound", () => {
  const source = readFileSync(
    resolve(
      fileURLToPath(new URL("../../..", import.meta.url)),
      reviewedTypeBoxConstructorPolicyForTest.sourceName,
    ),
    "utf8",
  );
  assert.doesNotThrow(() =>
    scanRuntimeLoaderSyntax(source, reviewedTypeBoxConstructorPolicyForTest.sourceName),
  );
  assert.doesNotThrow(() => validateReviewedTypeBoxConstructorShapeForTest(source));

  assert.throws(() =>
    scanRuntimeLoaderSyntax(
      source,
      reviewedTypeBoxConstructorPolicyForTest.sourceName.replace("@0.34.52", "@0.34.53"),
    ),
  );
  assert.throws(() =>
    scanRuntimeLoaderSyntax(`${source}\n`, reviewedTypeBoxConstructorPolicyForTest.sourceName),
  );
  assert.throws(() => scanRuntimeLoaderSyntax(source, "dist/control.mjs"));

  for (const mutated of [
    source.replace("IsFunction(value.constructor)", "value.constructor()"),
    source.replace("IsFunction(value.constructor) && ", ""),
    source.replace("IsFunction(value.constructor)", "new value.constructor()"),
    source.replace("value.constructor", 'value["constructor"]'),
    source.replace("value.constructor.name", "value.constructor.name.trim"),
    source.replace(
      "return IsObject(value)",
      "const { constructor: alias } = value; return IsObject(value)",
    ),
  ]) {
    assert.notEqual(mutated, source);
    assert.throws(() => validateReviewedTypeBoxConstructorShapeForTest(mutated));
  }
});

function staticExportSources(source, sourceName) {
  const program = parse(source, {
    sourceType: "module",
    sourceFilename: sourceName,
    plugins: ["typescript"],
  }).program;
  return program.body
    .filter(
      (statement) =>
        (statement.type === "ExportAllDeclaration" ||
          statement.type === "ExportNamedDeclaration") &&
        statement.source?.type === "StringLiteral",
    )
    .map((statement) => statement.source.value)
    .sort((left, right) => left.localeCompare(right, "en"));
}

function repositorySource(path) {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function replaceRequired(source, before, after) {
  const changed = source.replace(before, after);
  assert.notEqual(changed, source, `Missing architecture mutation target: ${before}`);
  return changed;
}
