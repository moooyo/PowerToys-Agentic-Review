import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

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
