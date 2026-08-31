import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";

const traverse = traverseModule.default ?? traverseModule;

const workerRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));

const allowedExternalImports = new Set(["node:crypto", "node:net", "node:process", "node:util"]);

const reviewedTypeBoxConstructorPolicy = Object.freeze({
  sourceName:
    "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/guard/guard.mjs",
  sha256: "93536544729b9cadcc69c9be124a1e2c0214f650de8b6e29757977c30d6ec9f2",
});

const forbiddenRuntimeLoaderProperties = new Set([
  "_linkedBinding",
  "_load",
  "binding",
  "dlopen",
  "mainModule",
]);

const allowedSharedInputs = new Set([
  "packages/local-protocol/src/capability.ts",
  "packages/local-protocol/src/canonical.ts",
  "packages/local-protocol/src/framing.ts",
  "packages/local-protocol/src/index.ts",
  "packages/local-protocol/src/messages.ts",
]);

const requiredPositiveSharedInputs = new Set([
  "packages/local-protocol/src/capability.ts",
  "packages/local-protocol/src/canonical.ts",
  "packages/local-protocol/src/framing.ts",
  "packages/local-protocol/src/messages.ts",
]);

const allowedRoleBridgeInputs = new Set(["apps/worker/src/service-host/typebox-value-check.ts"]);

const requiredPositiveTypeBoxInputs = new Set([
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/check/check.mjs",
]);

// This list is intentionally exact and version-bound. The build fails when the dependency graph
// changes, forcing a review of every newly executable third-party module.
const allowedTypeBoxInputs = new Set([
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/system/policy.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/any/any.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/argument/argument.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/array/array.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/async-iterator/async-iterator.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/awaited/awaited.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/bigint/bigint.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/boolean/boolean.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/clone/type.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/clone/value.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/composite/composite.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/computed/computed.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/const/const.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/constructor-parameters/constructor-parameters.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/constructor/constructor.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/create/immutable.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/create/type.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/date/date.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/discard/discard.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/enum/enum.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/error/error.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/exclude/exclude-from-mapped-result.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/exclude/exclude-from-template-literal.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/exclude/exclude.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/extends/extends-check.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/extends/extends-from-mapped-key.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/extends/extends-from-mapped-result.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/extends/extends-undefined.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/extends/extends.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/extract/extract-from-mapped-result.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/extract/extract-from-template-literal.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/extract/extract.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/function/function.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/guard/index.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/guard/kind.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/guard/type.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/guard/value.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/indexed/indexed-from-mapped-key.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/indexed/indexed-from-mapped-result.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/indexed/indexed-property-keys.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/indexed/indexed.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/instance-type/instance-type.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/instantiate/instantiate.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/integer/integer.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intersect/intersect-create.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intersect/intersect-evaluated.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intersect/intersect.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intrinsic/capitalize.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intrinsic/intrinsic-from-mapped-key.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intrinsic/intrinsic.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intrinsic/lowercase.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intrinsic/uncapitalize.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intrinsic/uppercase.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/iterator/iterator.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/keyof/keyof-from-mapped-result.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/keyof/keyof-property-keys.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/keyof/keyof.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/literal/literal.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/mapped/mapped-result.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/mapped/mapped.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/module/compute.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/module/module.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/never/never.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/not/not.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/null/null.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/number/number.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/object/object.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/omit/omit-from-mapped-key.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/omit/omit-from-mapped-result.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/omit/omit.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/optional/optional-from-mapped-result.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/optional/optional.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/parameters/parameters.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/partial/partial-from-mapped-result.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/partial/partial.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/patterns/patterns.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/pick/pick-from-mapped-key.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/pick/pick-from-mapped-result.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/pick/pick.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/promise/promise.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/readonly-optional/readonly-optional.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/readonly/readonly-from-mapped-result.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/readonly/readonly.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/record/record.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/recursive/recursive.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/ref/ref.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/regexp/regexp.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/registry/index.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/registry/format.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/registry/type.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/required/required-from-mapped-result.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/required/required.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/rest/rest.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/return-type/return-type.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/sets/set.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/string/string.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/symbol/symbol.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/symbols/symbols.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/template-literal/finite.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/template-literal/generate.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/template-literal/parse.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/template-literal/pattern.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/template-literal/syntax.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/template-literal/template-literal.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/template-literal/union.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/transform/transform.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/tuple/tuple.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/type/index.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/type/type.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/uint8array/uint8array.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/undefined/undefined.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/union/union-create.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/union/union-evaluated.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/union/union.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/unknown/unknown.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/unsafe/unsafe.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/void/void.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/check/check.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/deref/deref.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/guard/guard.mjs",
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/hash/hash.mjs",
]);

const specifications = Object.freeze({
  control: {
    entryPoint: "apps/worker/src/control-main.ts",
    outputs: new Set(["dist/control.mjs", "dist/control.mjs.map"]),
    requiredWorkerInputs: new Set([
      "apps/worker/src/control-main.ts",
      "apps/worker/src/service-host/arwx-stdio-channel.ts",
      "apps/worker/src/service-host/host-control-client.ts",
      "apps/worker/src/service-host/host-control-protocol.ts",
      "apps/worker/src/service-host/launch-contract.ts",
      "apps/worker/src/service-host/opaque-json.ts",
      "apps/worker/src/service-host/role-entrypoint.ts",
    ]),
  },
  executor: {
    entryPoint: "apps/worker/src/executor-main.ts",
    outputs: new Set(["dist/executor.mjs", "dist/executor.mjs.map"]),
    requiredWorkerInputs: new Set([
      "apps/worker/src/executor-main.ts",
      "apps/worker/src/service-host/arwx-stdio-channel.ts",
      "apps/worker/src/service-host/executor-host-control-session.ts",
      "apps/worker/src/service-host/launch-contract.ts",
      "apps/worker/src/service-host/role-entrypoint.ts",
    ]),
  },
});

const reviewedInputDigests = loadReviewedInputDigests();

export function verifyRoleBundle(role, metadata, outputFiles) {
  const specification = specifications[role];
  if (specification === undefined) throw new TypeError("Unknown role bundle policy.");
  if (metadata === null || typeof metadata !== "object") {
    throw new TypeError(`${role} bundle metadata is invalid.`);
  }

  const outputEntries = Object.entries(metadata.outputs ?? {});
  const outputNames = new Set(outputEntries.map(([name]) => normalizeMetadataPath(name)));
  assertExactSet(outputNames, specification.outputs, `${role} bundle outputs`);

  const mainOutputName = `dist/${role}.mjs`;
  const mainOutputEntry = outputEntries.find(
    ([name]) => normalizeMetadataPath(name) === mainOutputName,
  );
  if (mainOutputEntry === undefined) throw new Error(`${role} bundle output metadata is missing.`);
  const mainOutput = mainOutputEntry[1];
  const entryPoint = canonicalRepositoryInput(mainOutput.entryPoint);
  if (entryPoint !== specification.entryPoint) {
    throw new Error(`${role} bundle entry point is not role-bound: ${entryPoint}`);
  }

  const bundleInputs = new Map();
  for (const [metadataPath, contribution] of Object.entries(mainOutput.inputs ?? {})) {
    if (
      contribution === null ||
      typeof contribution !== "object" ||
      !Number.isSafeInteger(contribution.bytesInOutput) ||
      contribution.bytesInOutput < 0
    ) {
      throw new Error(`${role} bundle input has an invalid executable byte count: ${metadataPath}`);
    }
    const canonicalPath = canonicalRepositoryInput(metadataPath);
    if (bundleInputs.has(canonicalPath)) {
      throw new Error(`${role} bundle contains duplicate canonical input: ${canonicalPath}`);
    }
    bundleInputs.set(canonicalPath, {
      bytesInOutput: contribution.bytesInOutput,
      metadataPath,
    });
  }

  const allowedInputs = new Set([
    ...specification.requiredWorkerInputs,
    ...allowedRoleBridgeInputs,
    ...allowedSharedInputs,
    ...allowedTypeBoxInputs,
  ]);
  assertExactSet(new Set(bundleInputs.keys()), allowedInputs, `${role} bundle inputs`);
  assertRequiredPositiveInputs(role, bundleInputs, specification.requiredWorkerInputs);

  for (const imported of mainOutput.imports ?? []) {
    if (imported.external !== true || !allowedExternalImports.has(imported.path)) {
      throw new Error(`${role} bundle contains an unreviewed external import: ${imported.path}`);
    }
  }

  const expectedOutputPaths = new Set(
    [...specification.outputs].map((name) => resolve(workerRoot, name)),
  );
  const actualOutputPaths = new Set(outputFiles.map((file) => resolve(file.path)));
  assertExactSet(actualOutputPaths, expectedOutputPaths, `${role} emitted files`);

  for (const [canonicalPath, input] of bundleInputs) {
    const absolutePath = resolveMetadataInput(input.metadataPath);
    const sourceBytes = readFileSync(absolutePath);
    verifyReviewedInputDigest(canonicalPath, sourceBytes);
    scanRuntimeLoaderSyntax(sourceBytes.toString("utf8"), canonicalPath);
  }
  const bundle = outputFiles.find(
    (file) => resolve(file.path) === resolve(workerRoot, mainOutputName),
  );
  if (bundle === undefined) throw new Error(`${role} executable output is missing.`);
  scanRuntimeLoaderSyntax(bundle.text, mainOutputName);
}

export function verifyReviewedInputDigest(canonicalPath, sourceBytes) {
  if (typeof canonicalPath !== "string" || !(sourceBytes instanceof Uint8Array)) {
    throw new TypeError("Reviewed bundle input digest arguments are invalid.");
  }
  const expected = reviewedInputDigests[canonicalPath];
  if (expected === undefined) {
    throw new Error(`Bundle input has no reviewed content digest: ${canonicalPath}`);
  }
  const actual = createHash("sha256").update(sourceBytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`Bundle input content differs from review: ${canonicalPath}`);
  }
}

export function verifyCanonicalRoleGraph(role, graph) {
  const specification = specifications[role];
  if (specification === undefined) throw new TypeError("Unknown role bundle policy.");
  assertExactSet(new Set(graph.outputs), specification.outputs, `${role} bundle outputs`);
  if (graph.entryPoint !== specification.entryPoint) {
    throw new Error(`${role} bundle entry point is not role-bound.`);
  }
  const allowedInputs = new Set([
    ...specification.requiredWorkerInputs,
    ...allowedRoleBridgeInputs,
    ...allowedSharedInputs,
    ...allowedTypeBoxInputs,
  ]);
  for (const [input, bytesInOutput] of Object.entries(graph.inputs)) {
    if (!Number.isSafeInteger(bytesInOutput) || bytesInOutput < 0) {
      throw new Error(`${role} bundle input has an invalid executable byte count: ${input}`);
    }
  }
  assertExactSet(new Set(Object.keys(graph.inputs)), allowedInputs, `${role} bundle inputs`);
  assertRequiredPositiveInputs(
    role,
    new Map(
      Object.entries(graph.inputs).map(([input, bytesInOutput]) => [input, { bytesInOutput }]),
    ),
    specification.requiredWorkerInputs,
  );
}

function assertRequiredPositiveInputs(role, inputs, requiredWorkerInputs) {
  for (const input of [
    ...requiredWorkerInputs,
    ...requiredPositiveSharedInputs,
    ...requiredPositiveTypeBoxInputs,
  ]) {
    if ((inputs.get(input)?.bytesInOutput ?? 0) <= 0) {
      throw new Error(`${role} bundle critical input has no executable bytes: ${input}`);
    }
  }
}

export function scanRuntimeLoaderSyntax(source, sourceName) {
  // This review-time hazard lint is defense in depth, not a sandbox for hostile JavaScript.
  let sourceFile;
  try {
    sourceFile = parse(source, {
      sourceType: "module",
      plugins: sourceName.endsWith(".ts") ? ["typescript"] : [],
    });
  } catch {
    throw new Error(`${sourceName} could not be parsed for runtime-loader review.`);
  }
  const reviewedConstructorMembers = reviewedTypeBoxConstructorMembers(
    source,
    sourceName,
    sourceFile.program,
  );
  const privilegedRuntimeAliases = collectPrivilegedRuntimeAliases(sourceFile.program);
  const functionReferences = collectFunctionReferences(sourceFile);
  const forbiddenLoaderExtractions = collectForbiddenLoaderExtractions(
    sourceFile.program,
    privilegedRuntimeAliases,
  );
  const reject = (node, construct) => {
    const snippet = source.slice(node.start ?? 0, Math.min(node.end ?? 0, (node.start ?? 0) + 160));
    throw new Error(
      `${sourceName}:${node.loc?.start.line ?? 0}:${node.loc?.start.column ?? 0} uses forbidden ${construct}: ${snippet}`,
    );
  };
  const visit = (node, parent) => {
    if (node === null || typeof node !== "object") return;
    if (
      node.type === "Identifier" &&
      ["createRequire", "eval", "getBuiltinModule", "Reflect", "require"].includes(node.name)
    ) {
      reject(node, `runtime loader ${node.name}`);
    }
    if (
      node.type === "StringLiteral" &&
      ["createRequire", "eval", "getBuiltinModule", "require"].includes(node.value)
    ) {
      reject(node, `runtime loader name ${node.value}`);
    }
    if (
      node.type === "Identifier" &&
      node.name === "Function" &&
      functionReferences.referenced.has(node) &&
      !functionReferences.locallyBound.has(node)
    ) {
      reject(node, "Function constructor");
    }
    if (
      (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
      (isGlobalMember(node, "Function") ||
        (calledName(node) === "Function" &&
          node.object?.type === "Identifier" &&
          privilegedRuntimeAliases.has(node.object.name)) ||
        calledName(node) === "require" ||
        calledName(node) === "createRequire" ||
        (calledName(node) === "getBuiltinModule" && node.object?.name === "process"))
    ) {
      reject(node, `runtime loader ${calledName(node)}`);
    }
    if (
      (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
      node.computed === true &&
      node.object?.type === "Identifier" &&
      privilegedRuntimeAliases.has(node.object.name)
    ) {
      reject(node, "computed privileged-global access");
    }
    if (
      (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
      calledName(node) === "constructor" &&
      !reviewedConstructorMembers.has(node)
    ) {
      reject(node, "constructor property access");
    }
    if (
      (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
      forbiddenRuntimeLoaderProperties.has(calledName(node))
    ) {
      reject(node, `runtime loader property ${calledName(node)}`);
    }
    if (
      node.type === "ObjectProperty" &&
      parent?.type === "ObjectPattern" &&
      staticPropertyName(node.key, node.computed) === "constructor"
    ) {
      reject(node, "constructor property extraction");
    }
    if (
      node.type === "ObjectProperty" &&
      parent?.type === "ObjectPattern" &&
      forbiddenRuntimeLoaderProperties.has(staticPropertyName(node.key, node.computed))
    ) {
      reject(node, `runtime loader property ${staticPropertyName(node.key, node.computed)}`);
    }
    if (node.type === "ObjectProperty" && forbiddenLoaderExtractions.has(node)) {
      reject(node, forbiddenLoaderExtractions.get(node));
    }
    if (node.type === "ImportExpression") reject(node, "dynamic import");
    if (node.type === "CallExpression") {
      if (node.callee?.type === "Import") reject(node, "dynamic import");
      const name = calledName(node.callee);
      if (name === "require" || name === "createRequire" || name === "eval") {
        reject(node, `runtime loader ${name}`);
      }
      if (name === "getBuiltinModule") reject(node, "process.getBuiltinModule");
    }
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      (node.source?.value === "vm" || node.source?.value === "node:vm")
    ) {
      reject(node, "vm module import");
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      if (Array.isArray(value)) {
        for (const child of value) visit(child, node);
      } else {
        visit(value, node);
      }
    }
  };
  visit(sourceFile.program, undefined);
}

function reviewedTypeBoxConstructorMembers(source, sourceName, program) {
  if (sourceName !== reviewedTypeBoxConstructorPolicy.sourceName) return new Set();
  const digest = createHash("sha256").update(source, "utf8").digest("hex");
  if (digest !== reviewedTypeBoxConstructorPolicy.sha256) {
    throw new Error("Reviewed TypeBox constructor exception source digest changed.");
  }
  return validateReviewedTypeBoxConstructorShape(program);
}

export function validateReviewedTypeBoxConstructorShapeForTest(source) {
  let sourceFile;
  try {
    sourceFile = parse(source, { sourceType: "module" });
  } catch {
    throw new Error("Reviewed TypeBox constructor exception source could not be parsed.");
  }
  validateReviewedTypeBoxConstructorShape(sourceFile.program);
}

function validateReviewedTypeBoxConstructorShape(program) {
  const exports = program.body.filter(
    (node) =>
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "FunctionDeclaration" &&
      node.declaration.id?.name === "IsInstanceObject",
  );
  const owner = exports[0]?.declaration;
  if (
    exports.length !== 1 ||
    owner.type !== "FunctionDeclaration" ||
    owner.async ||
    owner.generator ||
    owner.params.length !== 1 ||
    owner.params[0]?.type !== "Identifier" ||
    owner.params[0].name !== "value" ||
    owner.body.body.length !== 1 ||
    owner.body.body[0]?.type !== "ReturnStatement"
  ) {
    throw new Error("Reviewed TypeBox IsInstanceObject declaration changed.");
  }

  const members = [];
  const extractions = [];
  const collect = (node, parent, grandparent, ancestors) => {
    if (node === null || typeof node !== "object") return;
    if (
      (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
      calledName(node) === "constructor"
    ) {
      members.push({ node, parent, grandparent, ancestors });
    }
    if (
      node.type === "ObjectProperty" &&
      parent?.type === "ObjectPattern" &&
      staticPropertyName(node.key, node.computed) === "constructor"
    ) {
      extractions.push(node);
    }
    const nextAncestors = [...ancestors, node];
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      if (Array.isArray(value)) {
        for (const child of value) collect(child, node, parent, nextAncestors);
      } else {
        collect(value, node, parent, nextAncestors);
      }
    }
  };
  collect(program, undefined, undefined, []);
  if (
    members.length !== 2 ||
    extractions.length !== 0 ||
    members.some((record) => !record.ancestors.includes(owner))
  ) {
    throw new Error("Reviewed TypeBox constructor access count or owner changed.");
  }

  const isDirectValueConstructor = (node) =>
    node.type === "MemberExpression" &&
    node.optional !== true &&
    node.computed === false &&
    node.object?.type === "Identifier" &&
    node.object.name === "value" &&
    node.property?.type === "Identifier" &&
    node.property.name === "constructor";
  const isFunctionGuard = (record) =>
    isDirectValueConstructor(record.node) &&
    record.parent?.type === "CallExpression" &&
    record.parent.optional !== true &&
    record.parent.callee?.type === "Identifier" &&
    record.parent.callee.name === "IsFunction" &&
    record.parent.arguments.length === 1 &&
    record.parent.arguments[0] === record.node;
  const isNameComparison = (record) =>
    isDirectValueConstructor(record.node) &&
    record.parent?.type === "MemberExpression" &&
    record.parent.optional !== true &&
    record.parent.computed === false &&
    record.parent.object === record.node &&
    record.parent.property?.type === "Identifier" &&
    record.parent.property.name === "name" &&
    record.grandparent?.type === "BinaryExpression" &&
    record.grandparent.operator === "!==" &&
    record.grandparent.left === record.parent &&
    record.grandparent.right?.type === "StringLiteral" &&
    record.grandparent.right.value === "Object";
  const functionGuards = members.filter(isFunctionGuard);
  const nameComparisons = members.filter(isNameComparison);
  if (functionGuards.length !== 1 || nameComparisons.length !== 1) {
    throw new Error("Reviewed TypeBox constructor access shape changed.");
  }
  return new Set(members.map((record) => record.node));
}

function collectFunctionReferences(sourceFile) {
  const referenced = new Set();
  const locallyBound = new Set();
  traverse(sourceFile, {
    ReferencedIdentifier(path) {
      if (path.node.name !== "Function") return;
      referenced.add(path.node);
      if (path.scope.getBinding("Function") !== undefined) locallyBound.add(path.node);
    },
  });
  return { locallyBound, referenced };
}

function collectForbiddenLoaderExtractions(program, privilegedRuntimeAliases) {
  const forbidden = new Map();
  const collect = (node, parent) => {
    if (node === null || typeof node !== "object") return;
    if (node.type === "ObjectPattern") {
      const source =
        parent?.type === "VariableDeclarator" && parent.id === node
          ? parent.init
          : parent?.type === "AssignmentExpression" && parent.left === node
            ? parent.right
            : parent?.type === "AssignmentPattern" && parent.left === node
              ? parent.right
              : undefined;
      const privilegedSource = isPrivilegedRuntimeSource(source, privilegedRuntimeAliases);
      for (const property of node.properties) {
        if (property.type !== "ObjectProperty") continue;
        const name = staticPropertyName(property.key, property.computed);
        if (name === "Function") {
          forbidden.set(property, "Function constructor extraction");
        } else if (forbiddenRuntimeLoaderProperties.has(name)) {
          forbidden.set(property, `runtime loader property ${name}`);
        } else if (property.computed && privilegedSource) {
          forbidden.set(property, "computed privileged-runtime extraction");
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      if (Array.isArray(value)) {
        for (const child of value) collect(child, node);
      } else {
        collect(value, node);
      }
    }
  };
  collect(program, undefined);
  return forbidden;
}

function isPrivilegedRuntimeSource(source, privilegedRuntimeAliases) {
  if (source?.type === "Identifier") return privilegedRuntimeAliases.has(source.name);
  return (
    (source?.type === "MemberExpression" || source?.type === "OptionalMemberExpression") &&
    source.object?.type === "Identifier" &&
    ["global", "globalThis"].includes(source.object.name) &&
    calledName(source) === "process"
  );
}

function collectPrivilegedRuntimeAliases(program) {
  const aliases = new Set([
    "Module",
    "global",
    "globalThis",
    "module",
    "process",
    "self",
    "window",
  ]);
  const edges = [];
  const collect = (node) => {
    if (node === null || typeof node !== "object") return;
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      node.init?.type === "Identifier"
    ) {
      edges.push([node.id.name, node.init.name]);
    }
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left?.type === "Identifier" &&
      node.right?.type === "Identifier"
    ) {
      edges.push([node.left.name, node.right.name]);
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      (node.init?.type === "MemberExpression" || node.init?.type === "OptionalMemberExpression") &&
      node.init.object?.type === "Identifier" &&
      ["global", "globalThis"].includes(node.init.object.name) &&
      calledName(node.init) === "process"
    ) {
      edges.push([node.id.name, "process"]);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      if (Array.isArray(value)) {
        for (const child of value) collect(child);
      } else {
        collect(value);
      }
    }
  };
  collect(program);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [alias, target] of edges) {
      if (aliases.has(target) && !aliases.has(alias)) {
        aliases.add(alias);
        changed = true;
      }
    }
  }
  return aliases;
}

function isGlobalMember(expression, name) {
  if (expression?.type !== "MemberExpression" && expression?.type !== "OptionalMemberExpression") {
    return false;
  }
  const propertyName = expression.computed ? expression.property?.value : expression.property?.name;
  return (
    propertyName === name &&
    expression.object?.type === "Identifier" &&
    ["global", "globalThis", "self", "window"].includes(expression.object.name)
  );
}

function calledName(expression) {
  if (expression?.type === "Identifier") return expression.name;
  if (
    (expression?.type === "MemberExpression" || expression?.type === "OptionalMemberExpression") &&
    expression.property !== undefined
  ) {
    return staticPropertyName(expression.property, expression.computed);
  }
  return undefined;
}

function staticPropertyName(property, computed) {
  if (!computed && property?.type === "Identifier") return property.name;
  return computed ? staticStringValue(property) : undefined;
}

function staticStringValue(expression) {
  if (expression?.type === "StringLiteral") return expression.value;
  if (expression?.type === "BinaryExpression" && expression.operator === "+") {
    const left = staticStringValue(expression.left);
    const right = staticStringValue(expression.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (expression?.type !== "TemplateLiteral") return undefined;
  let value = expression.quasis[0]?.value.cooked ?? expression.quasis[0]?.value.raw ?? "";
  for (let index = 0; index < expression.expressions.length; index += 1) {
    const substitution = staticStringValue(expression.expressions[index]);
    if (substitution === undefined) return undefined;
    const quasi = expression.quasis[index + 1];
    value += substitution + (quasi?.value.cooked ?? quasi?.value.raw ?? "");
  }
  return value;
}

function canonicalRepositoryInput(metadataPath) {
  if (typeof metadataPath !== "string" || metadataPath.length === 0) {
    throw new Error("Bundle metadata contains an invalid path.");
  }
  const absolutePath = resolveMetadataInput(metadataPath);
  const canonicalPath = realpathSync(absolutePath);
  const repositoryRelative = relative(repositoryRoot, canonicalPath);
  if (
    repositoryRelative === "" ||
    repositoryRelative === ".." ||
    repositoryRelative.startsWith(`..${sep}`) ||
    isAbsolute(repositoryRelative)
  ) {
    throw new Error(`Bundle input escapes the repository: ${metadataPath}`);
  }
  return normalizeMetadataPath(repositoryRelative);
}

function resolveMetadataInput(metadataPath) {
  return isAbsolute(metadataPath) ? metadataPath : resolve(workerRoot, metadataPath);
}

function normalizeMetadataPath(value) {
  return value.replaceAll("\\", "/");
}

function assertExactSet(actual, expected, description) {
  const missing = [...expected].filter((value) => !actual.has(value));
  const extra = [...actual].filter((value) => !expected.has(value));
  if (missing.length !== 0 || extra.length !== 0) {
    throw new Error(
      `${description} differ from policy; missing=[${missing.join(",")}], extra=[${extra.join(",")}].`,
    );
  }
}

function loadReviewedInputDigests() {
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(new URL("./reviewed-role-inputs.json", import.meta.url), "utf8"),
    );
  } catch {
    throw new Error("Reviewed role input digest manifest is missing or invalid.");
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.schemaVersion !== 1 ||
    manifest.inputs === null ||
    typeof manifest.inputs !== "object" ||
    Array.isArray(manifest.inputs) ||
    !Object.hasOwn(manifest, "schemaVersion") ||
    !Object.hasOwn(manifest, "inputs") ||
    Object.keys(manifest).length !== 2
  ) {
    throw new Error("Reviewed role input digest manifest has an invalid shape.");
  }

  const expectedInputs = new Set([
    ...Object.values(specifications).flatMap((specification) => [
      ...specification.requiredWorkerInputs,
    ]),
    ...allowedRoleBridgeInputs,
    ...allowedSharedInputs,
    ...allowedTypeBoxInputs,
  ]);
  const entries = Object.entries(manifest.inputs);
  assertExactSet(
    new Set(entries.map(([input]) => input)),
    expectedInputs,
    "reviewed role input digest manifest",
  );
  for (const [input, digest] of entries) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
      throw new Error(`Reviewed role input digest is invalid: ${input}`);
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

export const roleBundlePolicyForTest = Object.freeze(
  Object.fromEntries(
    Object.entries(specifications).map(([role, specification]) => [
      role,
      Object.freeze({
        entryPoint: specification.entryPoint,
        outputs: Object.freeze([...specification.outputs]),
        requiredWorkerInputs: Object.freeze([...specification.requiredWorkerInputs]),
        requiredPositiveInputs: Object.freeze([
          ...specification.requiredWorkerInputs,
          ...requiredPositiveSharedInputs,
          ...requiredPositiveTypeBoxInputs,
        ]),
        allowedInputs: Object.freeze([
          ...specification.requiredWorkerInputs,
          ...allowedRoleBridgeInputs,
          ...allowedSharedInputs,
          ...allowedTypeBoxInputs,
        ]),
      }),
    ]),
  ),
);

export const reviewedTypeBoxConstructorPolicyForTest = reviewedTypeBoxConstructorPolicy;
